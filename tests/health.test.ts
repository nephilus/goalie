import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { loader as livez, action as livezAction } from '../app/routes/livez';

const request = (method = 'GET') => new Request('http://localhost/health', { method });

test('liveness requires GET and has no database dependency', () => {
  assert.equal(livez({ request: request() }).status, 200);
  const denied = livezAction({ request: request('POST') });
  assert.equal(denied.status, 405);
  assert.equal(denied.headers.get('Allow'), 'GET');
});

test('readiness requires every bundled checksum and current workspace, allows additive upgrades, and fails closed', { skip: !process.env.WORK_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `health_test_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: url.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { pool, migrate } = await import('../app/server/db.server');
  const { loader, action } = await import('../app/routes/health');
  const check = async (status: number) => {
    const response = await loader({ request: request() });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { status: status === 200 ? 'ready' : 'error' });
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  };
  try {
    await check(503);
    const initial = readFileSync(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
    await pool.query(initial);
    await pool.query('CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())');
    await pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', ['0001', createHash('sha256').update(initial).digest('hex')]);
    await check(503);
    await migrate();
    await check(200);
    await pool.query("UPDATE schema_migrations SET checksum = 'wrong' WHERE version = '0001'");
    await check(503);
    await pool.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [createHash('sha256').update(initial).digest('hex'), '0001']);
    const removed = (await pool.query("DELETE FROM schema_migrations WHERE version = '0011' RETURNING version,checksum")).rows[0];
    await check(503);
    await pool.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [removed.version, removed.checksum]);
    await pool.query("INSERT INTO schema_migrations(version,checksum) VALUES('9999','future')");
    await check(200);
    await pool.query('BEGIN');
    await pool.query('DELETE FROM simple_workspace WHERE id=1');
    await check(503);
    await pool.query('ROLLBACK');
    const denied = await action({ request: request('POST') });
    assert.equal(denied.status, 405);
    assert.equal(denied.headers.get('Allow'), 'GET');
    await pool.end();
    await check(503);
    assert.equal(livez({ request: request() }).status, 200);
  } finally {
    if (!pool.ended) await pool.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
});
