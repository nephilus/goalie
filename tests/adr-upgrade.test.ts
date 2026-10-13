import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import type { Person } from '../app/shared/work';

// Replay the pre-ADR schema with synthetic data, then use the real runner to
// upgrade it. This never touches the caller's public schema or a live instance.
test('ADR migrations upgrade populated pre-ADR work without rewriting records', { skip: !process.env.WORK_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `adr_upgrade_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: url.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { pool, migrate, withTransaction } = await import('../app/server/db.server');
  try {
    await withTransaction(async client => {
      await client.query('CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())');
      const files = readdirSync(join(process.cwd(), 'migrations')).filter(file => /^\d+_.+\.sql$/.test(file) && Number(file.split('_')[0]) <= 11).sort();
      assert.equal(files.length, 11);
      for (const file of files) {
        const sql = readFileSync(join(process.cwd(), 'migrations', file), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [file.split('_')[0], createHash('sha256').update(sql).digest('hex')]);
      }
      await client.query("INSERT INTO people(id,name,email,team,role) VALUES('upgrade-editor','Upgrade editor','upgrade@example.test','','editor')");
      await client.query("INSERT INTO simple_workstreams(id,title,description,lead_id) VALUES('upgrade-stream','Existing stream','Synthetic preserved description','upgrade-editor')");
      await client.query("INSERT INTO simple_items(id,title,description,workstream_id,status,blocker) VALUES('upgrade-item','Existing work','Existing description','upgrade-stream','doing','')");
      await client.query("INSERT INTO simple_updates(id,item_id,author_id,body,kind,assignee_ids) VALUES('upgrade-post','upgrade-item','upgrade-editor','Existing note','note',ARRAY['upgrade-editor'])");
      await client.query('UPDATE simple_workspace SET revision=42 WHERE id=1');
    });
    const tables = ['people', 'simple_workspace', 'simple_workstreams', 'simple_items', 'simple_updates'];
    const before = await Promise.all(tables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY id`).then(result => result.rows)));
    // Reproduce an already-applied ADR schema before the forward-only fix.
    await withTransaction(async client => {
      for (const file of ['0012_adrs.sql', '0013_update_mentions.sql']) {
        const sql = readFileSync(join(process.cwd(), 'migrations', file), 'utf8');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [file.split('_')[0], createHash('sha256').update(sql).digest('hex')]);
      }
    });
    const constraints = async () => (await pool.query("SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='simple_notifications'::regclass ORDER BY conname")).rows;
    const legacyConstraints = await constraints();
    assert.equal(legacyConstraints.find(row => row.conname === 'simple_notifications_check1')?.definition, 'CHECK ((recipient_id <> actor_id))');
    const selfNotification = () => pool.query("INSERT INTO simple_notifications(id,recipient_id,actor_id,kind,item_id,update_id,dedupe_key) VALUES('self-notice','upgrade-editor','upgrade-editor','mention','upgrade-item','upgrade-post','self-notice')");
    await assert.rejects(selfNotification(), (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error && 'constraint' in error);
      assert.equal(error.code, '23514');
      assert.equal(error.constraint, 'simple_notifications_check1');
      return true;
    });
    await migrate();
    await migrate();
    assert.deepEqual(await constraints(), legacyConstraints.filter(row => row.conname !== 'simple_notifications_check1'), 'only the self-notification check is removed');
    const after = await Promise.all(tables.map(table => pool.query(`SELECT * FROM ${table} ORDER BY id`).then(result => result.rows)));
    assert.deepEqual(after, before, 'additive migrations preserve existing rows, timestamps, revision and attribution');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n, 14);
    for (const table of ['simple_adrs', 'simple_adr_history', 'simple_notifications', 'simple_update_mentions']) {
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0);
    }
    await selfNotification();
    const sqlError = (code: string, constraint: string) => (error: unknown) => {
      assert.ok(error && typeof error === 'object' && 'code' in error && 'constraint' in error);
      assert.equal(error.code, code);
      assert.equal(error.constraint, constraint);
      return true;
    };
    await assert.rejects(pool.query("UPDATE simple_notifications SET update_id=NULL WHERE id='self-notice'"), sqlError('23514', 'simple_notifications_check'));
    await assert.rejects(pool.query("UPDATE simple_notifications SET kind='unknown' WHERE id='self-notice'"), sqlError('23514', 'simple_notifications_kind_check'));
    await assert.rejects(pool.query("UPDATE simple_notifications SET recipient_id='missing' WHERE id='self-notice'"), sqlError('23503', 'simple_notifications_recipient_id_fkey'));
    await assert.rejects(pool.query("INSERT INTO simple_notifications(id,recipient_id,actor_id,kind,item_id,update_id,dedupe_key) VALUES('duplicate','upgrade-editor','upgrade-editor','mention','upgrade-item','upgrade-post','self-notice')"), sqlError('23505', 'simple_notifications_dedupe_key_key'));
    const actor: Person = { id: 'upgrade-editor', name: 'Upgrade editor', email: 'upgrade@example.test', role: 'editor' };
    const { readWork } = await import('../app/server/work.server');
    const state = await readWork(actor);
    assert.equal(state.revision, 42);
    assert.equal(state.updates[0].body, 'Existing note');
    assert.deepEqual(state.updates[0].mentionedPersonIds, []);
    const { executeAdr } = await import('../app/server/adr.server');
    const result = await executeAdr({ expectedRevision: 42, command: { type: 'adr.create', adr: {
      itemId: 'upgrade-item', context: 'Context', concern: 'Concern', decision: 'Decision', alternatives: 'Alternatives',
      consequences: 'Consequences', downsides: 'Downsides', rationale: 'Rationale', approver: { kind: 'name', name: 'External reviewer' },
    } } }, actor);
    assert.equal(result.revision, 43);
    assert.equal(result.adr.itemId, 'upgrade-item');
    assert.equal((await readWork(actor)).updates[0].body, 'Existing note');
  } finally {
    await pool.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
});
