import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { emptyItem, type Person, type Command } from '../app/shared/work';
import { adrUpdateInputSchema, type AdrCommandRequest, type Adr } from '../app/shared/adr';

// Every fixture and migration is scoped to a fresh synthetic schema, never public.
test('ADR services preserve authorization, immutable history and transactional concurrency', { skip: !process.env.WORK_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `adr_service_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: url.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { migrate, pool } = await import('../app/server/db.server');
  const { executeWork, readWork } = await import('../app/server/work.server');
  const { executeAdr, readAdr, readAdrHistory, listAdrs, listNotifications, setNotificationRead } = await import('../app/server/adr.server');
  const admin: Person = { id: 'admin', name: 'Admin', email: 'admin@example.test', role: 'admin' };
  const editor: Person = { id: 'editor', name: 'Editor', email: 'editor@example.test', role: 'editor' };
  const approver: Person = { id: 'approver', name: 'Approver', email: 'approver@example.test', role: 'editor' };
  const viewer: Person = { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', role: 'viewer' };
  const fields = { context: 'Context', concern: 'Concern', decision: 'Decision', alternatives: 'Alternatives', consequences: 'Consequences', downsides: 'Downsides', rationale: 'Rationale' };
  const work = async (command: Command) => executeWork({ expectedRevision: (await readWork(admin)).revision, command }, admin);
  const mutate = async (command: AdrCommandRequest['command'], actor = editor) => executeAdr({ expectedRevision: (await readWork(admin)).revision, command }, actor);
  const input = (adr: Adr) => adrUpdateInputSchema.parse(Object.fromEntries(Object.entries(adr).filter(([key]) => !['id', 'itemId', 'creatorId', 'status', 'revision', 'approval', 'createdAt', 'updatedAt'].includes(key))));
  const code = (expected: string) => (error: unknown) => Boolean(error && typeof error === 'object' && 'code' in error && error.code === expected);
  try {
    await migrate();
    await migrate();
    for (const person of [admin, editor, approver, viewer]) await pool.query('INSERT INTO people(id,name,email,team,role) VALUES($1,$2,$3,$4,$5)', [person.id, person.name, person.email, '', person.role]);
    const initial = await work({ type: 'workstream.create', workstream: { title: 'ADR stream', description: '', leadId: admin.id, goalIds: [] } });
    const streamId = initial.workstreams[0].id;
    const parentState = await work({ type: 'item.create', item: { ...emptyItem(streamId), title: 'Parent' } });
    const parentId = parentState.items[0].id;
    const childState = await work({ type: 'item.create', item: { ...emptyItem(streamId), title: 'Child', parentId } });
    const itemId = childState.items.find(item => item.parentId === parentId)!.id;
    const originalUpdates = (await work({ type: 'update.add', itemId, kind: 'note', body: 'Existing editable timeline note' })).updates;
    const create = { type: 'adr.create' as const, adr: { ...fields, itemId, approver: { kind: 'person' as const, personId: approver.id } } };
    let adr = (await mutate(create)).adr;

    await t.test('concurrent writers commit exactly one audit, notification and revision', async () => {
      const before = await readWork(admin);
      const counts = async () => (await pool.query('SELECT (SELECT count(*)::int FROM simple_adrs) AS adrs, (SELECT count(*)::int FROM simple_adr_history) AS history, (SELECT count(*)::int FROM simple_notifications) AS notifications')).rows[0];
      const old = await counts();
      const request = { expectedRevision: before.revision, command: { ...create, adr: { ...create.adr, mentionedPersonIds: [viewer.id] } } };
      const results = await Promise.allSettled([executeAdr(request, editor), executeAdr(request, editor)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      assert.equal(rejected.reason.code, 'revision_conflict');
      assert.deepEqual(await counts(), { adrs: old.adrs + 1, history: old.history + 1, notifications: old.notifications + 1 });
      const after = await readWork(admin);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.changes.length, before.changes.length + 1);
      await assert.rejects(executeAdr(request, editor), code('revision_conflict'));
      assert.deepEqual(await counts(), { adrs: old.adrs + 1, history: old.history + 1, notifications: old.notifications + 1 });
    });

    await t.test('actors are rechecked and existing-user approval cannot be forged', async () => {
      await assert.rejects(mutate(create, { ...viewer, role: 'admin' }), code('forbidden'));
      await assert.rejects(mutate(create, { ...admin, id: 'removed-account' }), code('forbidden'));
      await assert.rejects(mutate({ ...create, adr: { ...create.adr, documentUrl: 'not a URL' } }), code('invalid_command'));
      await assert.rejects(mutate({ ...create, adr: { ...create.adr, approver: { kind: 'person', personId: viewer.id } } }), code('invalid_reference'));
      adr = (await mutate({ type: 'adr.submit', id: adr.id })).adr;
      await assert.rejects(mutate({ type: 'adr.approve', id: adr.id }, admin), code('forbidden'));
      await assert.rejects(mutate({ type: 'adr.record_approval', id: adr.id }, admin), code('forbidden'));
      await work({ type: 'person.update', id: approver.id, person: { name: approver.name, email: approver.email, role: 'viewer' } });
      await assert.rejects(mutate({ type: 'adr.approve', id: adr.id }, approver), code('forbidden'));
      await work({ type: 'person.update', id: approver.id, person: { name: approver.name, email: approver.email, role: 'editor' } });
      adr = (await mutate({ type: 'adr.approve', id: adr.id }, approver)).adr;
      assert.equal(adr.approval?.actorId, approver.id);
      assert.equal(adr.approval?.mode, 'verified');
      assert.equal(adr.creatorId, editor.id);
    });

    await t.test('no-op and mentions-only edits retain approval, substantive edits invalidate it', async () => {
      const approved = adr.approval;
      adr = (await mutate({ type: 'adr.update', id: adr.id, adr: input(adr) })).adr;
      assert.equal(adr.status, 'approved');
      assert.deepEqual(adr.approval, approved);
      adr = (await mutate({ type: 'adr.update', id: adr.id, adr: { ...input(adr), mentionedPersonIds: [viewer.id, editor.id] } })).adr;
      assert.equal(adr.status, 'approved');
      assert.deepEqual(adr.approval, approved);
      const mentions = await listNotifications({}, viewer);
      assert.ok(mentions.items.some(item => item.adrId === adr.id && item.kind === 'mention'));
      assert.equal((await listNotifications({}, editor)).items.some(item => item.adrId === adr.id && item.kind === 'mention'), true);
      const count = (await pool.query("SELECT count(*)::int AS n FROM simple_notifications WHERE adr_id=$1 AND kind='mention'", [adr.id])).rows[0].n;
      adr = (await mutate({ type: 'adr.update', id: adr.id, adr: input(adr) })).adr;
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM simple_notifications WHERE adr_id=$1 AND kind='mention'", [adr.id])).rows[0].n, count);
      adr = (await mutate({ type: 'adr.update', id: adr.id, adr: { ...input(adr), decision: 'Changed decision' } })).adr;
      assert.equal(adr.status, 'draft');
      assert.equal(adr.approval, null);
      const history = await readAdrHistory({ adrId: adr.id }, viewer);
      assert.ok(history.items.some(entry => entry.snapshot.approval?.mode === 'verified'));
      adr = (await mutate({ type: 'adr.submit', id: adr.id })).adr;
      assert.ok((await listNotifications({}, approver)).items.some(item => item.adrId === adr.id && item.kind === 'approval_requested'));
      adr = (await mutate({ type: 'adr.update', id: adr.id, adr: { ...input(adr), approver: { kind: 'person', personId: admin.id } } })).adr;
      assert.equal(adr.status, 'draft');
      assert.equal((await listNotifications({}, approver)).items.some(item => item.adrId === adr.id && item.kind === 'approval_requested'), false);
      adr = (await mutate({ type: 'adr.submit', id: adr.id })).adr;
      await assert.rejects(mutate({ type: 'adr.approve', id: adr.id }, approver), code('forbidden'));
      adr = (await mutate({ type: 'adr.request_changes', id: adr.id, comment: 'Need rationale' }, admin)).adr;
      assert.equal(adr.status, 'changes_requested');
    });

    await t.test('self mentions and explicit self approval requests notify without changing draft or authorization semantics', async () => {
      let self = (await mutate({ ...create, adr: { ...create.adr, approver: { kind: 'person', personId: editor.id }, mentionedPersonIds: [editor.id] } })).adr;
      const notices = async () => (await listNotifications({}, editor)).items.filter(item => item.adrId === self.id);
      assert.equal(self.status, 'draft');
      assert.deepEqual((await notices()).map(item => item.kind), ['mention']);
      const mention = (await notices())[0];
      assert.equal(mention.actorId, editor.id);
      assert.equal(mention.recipientId, editor.id);
      await assert.rejects(mutate({ type: 'adr.approve', id: self.id }), code('invalid_transition'));
      self = (await mutate({ type: 'adr.update', id: self.id, adr: input(self) })).adr;
      assert.equal(self.status, 'draft');
      assert.deepEqual(await notices(), [mention], 'unchanged self mention does not resend or implicitly request approval');
      self = (await mutate({ type: 'adr.submit', id: self.id })).adr;
      assert.equal(self.status, 'pending');
      const request = (await notices()).find(item => item.kind === 'approval_requested')!;
      assert.ok(request);
      assert.equal(request.actorId, editor.id);
      assert.equal(request.recipientId, editor.id);
      await assert.rejects(setNotificationRead(request.id, true, admin), code('not_found'));
      await setNotificationRead(request.id, true, editor);
      assert.equal((await readAdr(self.id, editor)).adr.status, 'pending', 'reading does not approve');
      await assert.rejects(mutate({ type: 'adr.approve', id: self.id }, admin), code('forbidden'));
      await assert.rejects(mutate({ type: 'adr.submit', id: self.id }), code('invalid_transition'));
      self = (await mutate({ type: 'adr.approve', id: self.id })).adr;
      assert.equal(self.approval?.actorId, editor.id);
      assert.deepEqual(await notices(), [mention], 'request is invalidated and self approval results stay suppressed');
      self = (await mutate({ type: 'adr.update', id: self.id, adr: { ...input(self), mentionedPersonIds: [] } })).adr;
      assert.deepEqual(await notices(), []);
      await assert.rejects(setNotificationRead(mention.id, true, editor), code('not_found'));
      self = (await mutate({ type: 'adr.update', id: self.id, adr: { ...input(self), mentionedPersonIds: [editor.id] } })).adr;
      assert.equal((await notices()).length, 1);
      assert.notEqual((await notices())[0].id, mention.id);
      assert.equal(self.status, 'approved', 'mentions alone do not change review state');
    });

    await t.test('plain-name approval rejects account bypass and newly provisioned collisions', async () => {
      await assert.rejects(mutate({ ...create, adr: { ...create.adr, approver: { kind: 'name', name: '  APPROVER  ' } } }), code('invalid_reference'));
      const external = (await mutate({ ...create, adr: { ...create.adr, approver: { kind: 'name', name: 'External reviewer' } } })).adr;
      await mutate({ type: 'adr.submit', id: external.id });
      const approved = await mutate({ type: 'adr.record_approval', id: external.id }, admin);
      assert.equal(approved.adr.approval?.mode, 'recorded');
      assert.equal(approved.adr.approval?.comment, '');
      assert.equal(approved.adr.approval?.actorId, admin.id);
      const collision = (await mutate({ ...create, adr: { ...create.adr, approver: { kind: 'name', name: 'Future person' } } })).adr;
      await mutate({ type: 'adr.submit', id: collision.id });
      await work({ type: 'person.create', person: { name: 'Future person', email: 'future@example.test', role: 'editor' } });
      await assert.rejects(mutate({ type: 'adr.record_approval', id: collision.id }), code('invalid_reference'));
      assert.equal((await readAdr(collision.id, viewer)).adr.status, 'pending');
    });

    await t.test('private read state does not advance revision and all reads include global revision', async () => {
      const notification = (await listNotifications({}, viewer)).items[0];
      const revision = (await readWork(admin)).revision;
      await assert.rejects(setNotificationRead(notification.id, true, admin), code('not_found'));
      assert.ok((await setNotificationRead(notification.id, true, viewer)).readAt);
      assert.equal((await readWork(admin)).revision, revision);
      assert.equal((await setNotificationRead(notification.id, false, viewer)).readAt, null);
      const next = await work({ type: 'goal.create', goal: { title: 'Unrelated', description: '', targetDate: null } });
      for (const result of [await readAdr(adr.id, viewer), await listAdrs({}, viewer), await readAdrHistory({ adrId: adr.id }, viewer), await listNotifications({}, viewer)]) assert.equal(result.revision, next.revision);
      assert.notEqual((await readAdr(adr.id, viewer)).adr.revision, next.revision);
      const first = await listAdrs({ limit: 1 }, viewer);
      assert.equal(first.items.length, 1);
      assert.ok(first.nextCursor);
      const second = await listAdrs({ limit: 1, cursor: first.nextCursor! }, viewer);
      assert.notEqual(first.items[0].id, second.items[0].id);
      assert.equal((await listAdrs({ personId: admin.id, role: 'approver', status: 'changes_requested' }, viewer)).items[0].id, adr.id);
    });

    await t.test('owner deletion and historical person references are retained', async () => {
      await assert.rejects(work({ type: 'item.delete', id: itemId }), code('entity_in_use'));
      await pool.query('INSERT INTO people(id,name,email,team,role) VALUES($1,$2,$3,$4,$5)', ['historical', 'Historical requester', 'historical@example.test', '', 'editor']);
      let record = (await mutate({ ...create, adr: { ...create.adr, requester: { kind: 'person', personId: 'historical' } } })).adr;
      record = (await mutate({ type: 'adr.update', id: record.id, adr: { ...input(record), requester: { kind: 'name', name: 'External requester' } } })).adr;
      await assert.rejects(work({ type: 'person.delete', id: 'historical' }), code('entity_in_use'));
      await assert.rejects(pool.query('DELETE FROM people WHERE id=$1', ['historical']), (error: unknown) => {
        assert.ok(error && typeof error === 'object' && 'code' in error && 'constraint' in error);
        assert.ok(['23503', '23001'].includes(String(error.code)), `Unexpected SQLSTATE ${String(error.code)}`);
        assert.equal(error.constraint, 'simple_adr_history_people_person_id_fkey');
        return true;
      });
      assert.equal((await readAdr(record.id, admin)).adr.creatorId, editor.id);
    });

    await t.test('every historical snapshot captures all person references relationally', async () => {
      const snapshots = (await pool.query('SELECT id,actor_id,snapshot FROM simple_adr_history')).rows;
      for (const row of snapshots) {
        const snapshot = row.snapshot as Adr;
        const expected = new Set([row.actor_id, snapshot.creatorId, ...snapshot.mentionedPersonIds]);
        for (const identity of [snapshot.requester, snapshot.approver, snapshot.approval?.approver]) if (identity?.kind === 'person') expected.add(identity.personId);
        if (snapshot.approval) expected.add(snapshot.approval.actorId);
        const actual = (await pool.query('SELECT person_id FROM simple_adr_history_people WHERE history_id=$1 ORDER BY person_id', [row.id])).rows.map(person => person.person_id);
        assert.deepEqual(actual, [...expected].sort());
      }
    });

    await t.test('late transactional failure rolls back ADR history references and notifications', async () => {
      const counts = async () => (await pool.query('SELECT (SELECT count(*)::int FROM simple_adrs) AS adrs, (SELECT count(*)::int FROM simple_adr_history) AS history, (SELECT count(*)::int FROM simple_adr_history_people) AS history_people, (SELECT count(*)::int FROM simple_notifications) AS notifications, (SELECT count(*)::int FROM simple_changes) AS changes, (SELECT revision FROM simple_workspace WHERE id=1) AS revision')).rows[0];
      const before = await counts();
      await pool.query("CREATE FUNCTION fail_adr_change() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'adr.create' THEN RAISE EXCEPTION 'forced ADR rollback'; END IF; RETURN NEW; END $$");
      await pool.query('CREATE TRIGGER force_adr_rollback BEFORE INSERT ON simple_changes FOR EACH ROW EXECUTE FUNCTION fail_adr_change()');
      try {
        await assert.rejects(mutate({ ...create, adr: { ...create.adr, mentionedPersonIds: [viewer.id] } }), code('P0001'));
        assert.deepEqual(await counts(), before);
      } finally {
        await pool.query('DROP TRIGGER force_adr_rollback ON simple_changes');
        await pool.query('DROP FUNCTION fail_adr_change()');
      }
    });

    await t.test('work snapshots project immutable ADR activity without creating editable updates', async () => {
      const history = (await pool.query('SELECT id,adr_id,actor_id,action,comment,revision,snapshot,created_at FROM simple_adr_history ORDER BY created_at,id')).rows;
      const snapshot = await readWork(viewer);
      assert.deepEqual(snapshot.updates, originalUpdates, 'all ADR mutations leave existing editable notes untouched');
      assert.deepEqual(snapshot.adrActivities, history.map(row => ({
        id: row.id, adrId: row.adr_id, itemId: row.snapshot.itemId, authorId: row.actor_id,
        action: row.action, decision: row.snapshot.decision, comment: row.comment,
        approvalMode: row.snapshot.approval?.mode ?? null,
        revision: Number(row.revision), createdAt: row.created_at.toISOString(),
      })));
      const activities = snapshot.adrActivities!;
      assert.deepEqual([...new Set(activities.map(entry => entry.action))].sort(), ['adr.approve', 'adr.create', 'adr.record_approval', 'adr.request_changes', 'adr.submit', 'adr.update']);
      const initial = activities.find(entry => entry.adrId === adr.id && entry.action === 'adr.create')!;
      assert.equal(initial.decision, fields.decision, 'creation retains original decision after later edits');
      assert.equal(initial.authorId, editor.id);
      assert.ok(activities.some(entry => entry.adrId === adr.id && entry.decision === 'Changed decision'));
      assert.ok(activities.some(entry => entry.action === 'adr.approve' && entry.authorId === approver.id && entry.approvalMode === 'verified'));
      assert.ok(activities.some(entry => entry.action === 'adr.record_approval' && entry.authorId === admin.id && entry.approvalMode === 'recorded'));
      await assert.rejects(work({ type: 'update.delete', id: initial.id }), code('not_found'));
      assert.deepEqual((await readWork(admin)).adrActivities, activities, 'normal update deletion cannot remove ADR history');
    });

    await t.test('SQL constraints reject malformed identities and nonexistent account references', async () => {
      for (const identity of [{}, { kind: 'person' }, { kind: 'other', name: 'X' }, { kind: 'name', name: '' }, { kind: 'person', personId: editor.id, name: 'X' }]) {
        await assert.rejects(pool.query('UPDATE simple_adrs SET requester=$2::jsonb WHERE id=$1', [adr.id, JSON.stringify(identity)]), code('23514'));
      }
      await assert.rejects(pool.query('UPDATE simple_adrs SET requester=$2::jsonb WHERE id=$1', [adr.id, JSON.stringify({ kind: 'person', personId: 'absent' })]), code('23503'));
    });
  } finally {
    await pool.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
});
