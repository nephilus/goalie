import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);
const engine = process.env.CONTAINER_ENGINE || 'docker';
const image = process.argv[2];
const revision = process.env.EXPECTED_REVISION;
assert(['docker', 'podman'].includes(engine), 'CONTAINER_ENGINE must be docker or podman');
assert(image && !image.startsWith('-') && process.argv.length === 3, 'Usage: node scripts/smoke-image.mjs <image>');
assert(revision, 'EXPECTED_REVISION is required');
assert(process.env.WORK_TEST_DATABASE_URL, 'WORK_TEST_DATABASE_URL is required; no .env fallback');
let database;
try { database = new URL(process.env.WORK_TEST_DATABASE_URL); }
catch { throw new Error('WORK_TEST_DATABASE_URL must be a valid disposable PostgreSQL URL'); }
assert(['postgres:', 'postgresql:'].includes(database.protocol), 'Disposable database must use PostgreSQL');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname), 'Disposable database must be loopback');
assert(database.pathname === '/goalie_ci' && !database.search && !database.hash, 'Disposable database must be goalie_ci without URL options');
const names = { migration: `goalie-smoke-migrate-${randomUUID()}`, app: `goalie-smoke-app-${randomUUID()}` };
const owned = new Set();
const redact = text => String(text).split(database.href).join('[database]').replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[database]');
const run = async args => {
  try { return (await exec(engine, args, { maxBuffer: 4 * 1024 * 1024, timeout: 120_000 })).stdout; }
  catch (error) { throw new Error(`${engine} ${args[0]} failed: ${redact(error.stderr || error.stdout || 'command failed')}`); }
};
const cleanup = async () => { for (const name of owned) await exec(engine, ['rm', '-f', name], { timeout: 15_000 }).catch(() => { }); };
let terminating = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  terminating = true;
  await cleanup();
  process.exit(signal === 'SIGINT' ? 130 : 143);
});
const pool = new pg.Pool({ connectionString: database.href, connectionTimeoutMillis: 10_000, statement_timeout: 10_000 });
try {
  const inspected = JSON.parse(await run(['image', 'inspect', image]))[0];
  const user = inspected.Config.User;
  assert(user && !['root', '0'].includes(user.split(':')[0]), 'Image must default to a nonroot user');
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(inspected.Config.Labels?.['org.opencontainers.image.version'], version, 'Image version mismatch');
  assert.equal(inspected.Config.Labels?.['org.opencontainers.image.revision'], revision, 'Image revision mismatch');
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const settings = {
    NODE_ENV: 'development', DATABASE_URL: database.href, HOST: '127.0.0.1', PORT: String(port),
    APP_URL: origin, OIDC_ISSUER: 'http://127.0.0.1:5558/dex', OIDC_CLIENT_ID: 'goalie-smoke',
    OIDC_CLIENT_SECRET: 'synthetic-smoke-only', AI_ENABLED: 'false', OPENJEV_ENABLED: 'false',
  };
  const flags = ['--network', 'host', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', ...Object.entries(settings).flatMap(([key, value]) => ['--env', `${key}=${value}`])];
  owned.add(names.migration);
  await run(['run', '--name', names.migration, ...flags, image, 'node', 'build/migrate.mjs']);
  const directory = new URL('../migrations/', import.meta.url);
  const expected = await Promise.all((await readdir(directory)).filter(file => /^\d+_.+\.sql$/.test(file)).sort().map(async file => ({
    version: file.slice(0, file.indexOf('_')),
    checksum: createHash('sha256').update(await readFile(new URL(file, directory))).digest('hex'),
  })));
  assert.deepEqual((await pool.query('SELECT version, checksum FROM schema_migrations ORDER BY version')).rows, expected, 'Complete migration ledger must match checked-in SQL');
  owned.add(names.app);
  await run(['run', '-d', '--name', names.app, ...flags, image]);
  let ready = false;
  for (let attempt = 0; attempt < 60 && !terminating; attempt++) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 200 && (await response.json()).status === 'ready') { ready = true; break; }
    } catch { /* Startup is bounded by the loop deadline. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(ready, 'Container did not become ready');
  const request = path => fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  assert.equal((await request('/api/work')).status, 401, 'Work API must reject unauthenticated requests');
  const root = await request('/');
  assert.equal(root.status, 302, 'Work UI must redirect unauthenticated requests');
  const login = new URL(root.headers.get('location'), origin);
  assert.equal(login.origin, origin);
  assert.equal(login.pathname, '/auth/login');
  const manifestResponse = await request('/manifest.webmanifest');
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.name, 'Goalie');
  assert(Array.isArray(manifest.icons) && manifest.icons.length > 0, 'Manifest must advertise icons');
  for (const icon of manifest.icons) {
    const url = new URL(icon.src, origin);
    assert.equal(url.origin, origin, 'Icon must be local');
    const response = await request(url.pathname);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /^image\//);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (icon.type === 'image/png') assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'Icon must be PNG data');
  }
  console.log(`Image smoke passed: ${expected.length} migrations, health ready, API 401, UI login redirect, manifest/icons, nonroot ${user}, version ${version}, revision ${revision}`);
} catch (error) {
  console.error(redact(error.message));
  if (owned.has(names.app)) console.error(redact(await run(['logs', '--tail', '60', names.app]).catch(() => 'Container logs unavailable')));
  process.exitCode = 1;
} finally {
  await pool.end();
  await cleanup();
}
