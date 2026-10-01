import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { validateRepository } from './release-preflight.mjs';

const exec = promisify(execFile);
const directory = process.argv[2] && resolve(process.argv[2]);
assert(directory && process.argv.length === 3, 'Usage: node scripts/rescan-release.mjs <report-directory>');
await mkdir(directory, { recursive: true, mode: 0o700 });
const summary = { status: 'error', observedAt: new Date().toISOString() };
let authDirectory;
let authEnv;
let engine;
const secret = process.env.GITHUB_TOKEN;
const redact = value => String(value).split(secret || '\0').join('[redacted]');
const run = async (command, args, options = {}) => {
  try { return await exec(command, args, { timeout: 900_000, maxBuffer: 4 * 1024 * 1024, ...options }); }
  catch (error) { throw new Error(`${command} ${args[0]} failed: ${redact(error.stderr || error.message)}`); }
};
try {
  const repository = validateRepository(process.env.GITHUB_REPOSITORY);
  assert(secret, 'GITHUB_TOKEN is required for released-image verification');
  engine = process.env.CONTAINER_ENGINE || 'docker';
  assert(['docker', 'podman'].includes(engine), 'CONTAINER_ENGINE must be docker or podman');
  const api = new URL(process.env.GITHUB_API_URL || 'https://api.github.com/');
  if (!api.pathname.endsWith('/')) api.pathname += '/';
  const get = path => fetch(new URL(path, api), { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${secret}`, 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) });
  const repoResponse = await get(`repos/${repository}`);
  assert(repoResponse.ok, `Cannot verify repository access: HTTP ${repoResponse.status}`);
  const response = await get(`repos/${repository}/releases/latest`);
  if (response.status === 404) {
    summary.status = 'no-published-stable-release';
    summary.message = 'No published stable version exists; no released-image rescan occurred.';
    console.log(summary.message);
  } else {
    assert(response.ok, `Cannot resolve latest stable release: HTTP ${response.status}`);
    const release = await response.json();
    assert(typeof release.tag_name === 'string', 'Latest stable release has no tag');
    const validationPath = join(directory, 'release-validation.json');
    await run(process.execPath, ['scripts/release-preflight.mjs', '--tag', release.tag_name, '--repository', repository, '--output', validationPath]);
    const validated = JSON.parse(await readFile(validationPath, 'utf8'));
    const image = `ghcr.io/${repository.toLowerCase()}:${validated.version}`;
    authDirectory = await mkdtemp(join(tmpdir(), 'goalie-rescan-auth-'));
    authEnv = { ...process.env, DOCKER_CONFIG: authDirectory, REGISTRY_AUTH_FILE: join(authDirectory, 'auth.json') };
    const user = process.env.GITHUB_ACTOR || repository.split('/')[0];
    const login = exec(engine, ['login', 'ghcr.io', '--username', user, '--password-stdin'], { env: authEnv, timeout: 60_000, maxBuffer: 1024 * 1024 });
    login.child.stdin.end(secret);
    await login.catch(error => { throw new Error(`GHCR authentication failed: ${redact(error.stderr || error.message)}`); });
    await run(engine, ['pull', '--platform', 'linux/amd64', image], { env: authEnv });
    const inspected = JSON.parse((await run(engine, ['image', 'inspect', image], { env: authEnv })).stdout)[0];
    assert.equal(inspected.Config.Labels?.['org.opencontainers.image.version'], validated.version, 'Released image version label mismatch');
    assert.equal(inspected.Config.Labels?.['org.opencontainers.image.revision'], validated.commit, 'Released image source label mismatch');
    summary.release = validated;
    summary.image = image;
    summary.imageId = inspected.Id;
    await run(process.execPath, ['scripts/scan-image.mjs', image, join(directory, 'image')], { env: { ...authEnv, EXPECTED_REVISION: validated.commit } });
    summary.status = 'passed';
    console.log(`Released image rescan passed: ${image} at ${validated.commit}. This does not identify deployed customer images.`);
  }
} catch (error) {
  summary.error = redact(error.message);
  console.error(summary.error);
  process.exitCode = 1;
} finally {
  if (authDirectory) {
    await run(engine, ['logout', 'ghcr.io'], { env: authEnv, timeout: 30_000 }).catch(() => { });
    await rm(authDirectory, { recursive: true, force: true });
  }
  summary.finishedAt = new Date().toISOString();
  await writeFile(join(directory, 'release-rescan.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
}
