import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { emptyItem, itemInputSchema, type Command, type ItemInput, type Person, type Snapshot } from '../app/shared/work';
import { DEFAULT_WORK_FILTERS, matchesBaseWorkFilters, workFiltersSchema, type WorkFilters } from '../app/shared/work-filters';
import { assessmentScopeSchema } from '../app/shared/work-assessment';

// A separate disposable schema; never run migrations or fixtures in the caller's schema.
test('shared work preserves hierarchy, goal alignment, permissions and concurrent edits', { skip: !process.env.WORK_TEST_DATABASE_URL }, async () => {
  const url = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `work_test_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: url.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { migrate, pool } = await import('../app/server/db.server');
  const { executeWork, readWork } = await import('../app/server/work.server');
  try {
    await migrate();
    const admin: Person = { id: 'admin', name: 'Admin', email: 'admin@example.test', role: 'admin' };
    const editor: Person = { id: 'editor', name: 'Editor', email: 'editor@example.test', role: 'editor' };
    const viewer: Person = { id: 'viewer', name: 'Viewer', email: 'viewer@example.test', role: 'viewer' };
    for (const person of [admin, editor, viewer]) await pool.query('INSERT INTO people(id,name,email,team,role) VALUES($1,$2,$3,$4,$5)', [person.id, person.name, person.email, '', person.role]);
    let state = await readWork(admin);
    const apply = async (command: Command, actor = admin) => state = await executeWork({ expectedRevision: state.revision, command }, actor);
    const assigned = (item: ItemInput, assigneeIds = [admin.id]): ItemInput => ({ ...item, assigneeIds });
    const reject = async (command: Command, code: string, actor = admin) => {
      const revision = state.revision;
      await assert.rejects(executeWork({ expectedRevision: revision, command }, actor), (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === code);
      assert.equal((await readWork(admin)).revision, revision, 'failed operation must not advance revision');
    };
    const rejectStale = async (command: Command) => {
      const revision = state.revision;
      await assert.rejects(executeWork({ expectedRevision: revision - 1, command }, admin), (error: unknown) => error !== null && typeof error === 'object' && 'code' in error && error.code === 'revision_conflict');
      assert.equal((await readWork(admin)).revision, revision, 'stale operation must not advance revision');
    };
    const personCreate: Command = { type: 'person.create', person: { name: 'New Person', email: ' New.Person@Example.Test ', role: 'viewer' } };
    await apply(personCreate);
    const provisioned = state.people.find(person => person.name === 'New Person')!;
    assert.equal(provisioned.email, 'new.person@example.test');
    const provisionedInput = { name: provisioned.name, email: provisioned.email, role: provisioned.role };
    await apply({ type: 'person.update', id: provisioned.id, person: { ...provisionedInput, name: 'Renamed Person', role: 'editor' } });
    assert.equal(state.people.find(person => person.id === provisioned.id)?.name, 'Renamed Person');
    assert.equal(state.people.find(person => person.id === provisioned.id)?.role, 'editor', 'readWork must expose the updated role');
    await reject({ type: 'person.create', person: { name: 'Duplicate Email', email: 'NEW.PERSON@example.test', role: 'viewer' } }, 'duplicate_email');
    await reject({ type: 'person.update', id: provisioned.id, person: { ...provisionedInput, email: 'changed@example.test', role: 'editor' } }, 'email_immutable');
    await reject({ type: 'person.create', person: { name: 'Editor Attempt', email: 'editor-attempt@example.test', role: 'viewer' } }, 'forbidden', editor);
    await reject({ type: 'person.create', person: { name: 'Viewer Attempt', email: 'viewer-attempt@example.test', role: 'viewer' } }, 'forbidden', viewer);
    await reject({ type: 'person.update', id: admin.id, person: { name: admin.name, email: admin.email, role: 'editor' } }, 'last_admin');
    await reject({ type: 'person.create', person: { name: 'Forged Admin Attempt', email: 'forged-admin@example.test', role: 'viewer' } }, 'forbidden', { ...editor, role: 'admin' });
    await apply({ type: 'person.update', id: provisioned.id, person: { ...provisionedInput, role: 'admin' } });
    const formerAdmin: Person = { ...provisioned, role: 'admin' };
    await apply({ type: 'person.update', id: provisioned.id, person: { ...provisionedInput, role: 'viewer' } });
    await reject({ type: 'person.create', person: { name: 'Revoked grant', email: 'revoked-grant@example.test', role: 'admin' } }, 'forbidden', formerAdmin);
    await apply({ type: 'goal.create', goal: { title: 'Goal', description: '', targetDate: '2026-12-01' } });
    const goalId = state.goals[0].id;
    await apply({ type: 'workstream.create', workstream: { title: 'One', description: '', leadId: admin.id, goalIds: [goalId] } });
    const streamId = state.workstreams[0].id;
    await apply({ type: 'workstream.create', workstream: { title: 'Two', description: '', leadId: editor.id, goalIds: [] } });
    const other = state.workstreams.find(stream => stream.id !== streamId)!;
    await apply({ type: 'item.create', item: { ...emptyItem(streamId), title: 'Unassigned', blocker: 'Waiting on an owner.' } });
    const unassigned = state.items.find(item => item.title === 'Unassigned')!;
    assert.deepEqual(unassigned.assigneeIds, []);
    assert.equal(unassigned.blocker, 'Waiting on an owner.');
    const legacyBlockerEvent = state.updates.find(update => update.itemId === unassigned.id && update.kind === 'blocker');
    assert.equal(legacyBlockerEvent?.body, 'Waiting on an owner.');
    assert.equal(legacyBlockerEvent?.authorId, admin.id);
    await reject({ type: 'item.create', item: { ...emptyItem(streamId), title: 'Duplicate assignee', assigneeIds: [admin.id, admin.id] } }, 'invalid_command');
    await reject({ type: 'item.create', item: { ...emptyItem(streamId), title: 'Unknown assignee', assigneeIds: ['missing-person'] } }, 'invalid_reference');
    await apply({ type: 'item.create', item: { ...assigned(emptyItem(other.id)), title: 'Unaligned' } });
    await apply({ type: 'item.create', item: { ...assigned(emptyItem(streamId), [editor.id, admin.id]), title: 'Parent' } });
    const parent = state.items.find(item => item.title === 'Parent')!;
    assert.equal('goalId' in parent, false);
    assert.equal(matchesBaseWorkFilters(parent, state, { ...DEFAULT_WORK_FILTERS, goalIds: [goalId] }, 'all', admin.id, null), true);
    assert.deepEqual(parent.assigneeIds, [admin.id, editor.id]);
    assert.equal((await pool.query('SELECT assignee_id FROM simple_items WHERE id = $1', [parent.id])).rows[0].assignee_id, null);
    assert.deepEqual((await pool.query('SELECT person_id FROM simple_item_assignees WHERE item_id = $1 ORDER BY person_id', [parent.id])).rows.map(row => row.person_id), [admin.id, editor.id]);
    await apply({ type: 'item.create', item: { ...assigned(emptyItem(streamId)), title: 'Child', parentId: parent.id } });
    const child = state.items.find(item => item.parentId === parent.id)!;
    const input = (item: typeof parent) => { const { id, createdAt, updatedAt, ...value } = item; return value; };
    const starRevision = state.revision;
    const viewerStar = await executeWork({ expectedRevision: starRevision - 1, command: { type: 'item.star', itemId: parent.id, starred: true } }, viewer);
    assert.equal(viewerStar.revision, starRevision);
    assert.deepEqual(viewerStar.starredItemIds, [parent.id]);
    assert.equal((await readWork(admin)).starredItemIds.includes(parent.id), false);
    const viewerRepeatStar = await executeWork({ expectedRevision: 0, command: { type: 'item.star', itemId: parent.id, starred: true } }, viewer);
    assert.deepEqual(viewerRepeatStar.starredItemIds, [parent.id]);
    assert.equal(viewerRepeatStar.revision, starRevision);
    const viewerUnstar = await executeWork({ expectedRevision: Number.MAX_SAFE_INTEGER, command: { type: 'item.star', itemId: parent.id, starred: false } }, viewer);
    assert.deepEqual(viewerUnstar.starredItemIds, []);
    assert.equal(viewerUnstar.changes.length, state.changes.length);
    const parentBeforeBlocker = state.items.find(item => item.id === parent.id)!;
    await apply({ type: 'item.update', id: parent.id, item: { ...input(parentBeforeBlocker), blocker: 'Blocked by dependency.' } });
    const firstBlocker = state.updates.find(update => update.itemId === parent.id && update.kind === 'blocker' && update.body === 'Blocked by dependency.')!;
    assert.equal(state.items.find(item => item.id === parent.id)?.blocker, 'Blocked by dependency.');
    const blockerEventCount = state.updates.filter(update => update.itemId === parent.id && (update.kind === 'blocker' || update.kind === 'blocker_resolved')).length;
    const parentWithBlocker = state.items.find(item => item.id === parent.id)!;
    await apply({ type: 'item.update', id: parent.id, item: { ...input(parentWithBlocker), blocker: 'Blocked by dependency.' } });
    assert.equal(state.updates.filter(update => update.itemId === parent.id && (update.kind === 'blocker' || update.kind === 'blocker_resolved')).length, blockerEventCount);
    await reject({ type: 'update.add', itemId: parent.id, kind: 'blocker', body: 'x'.repeat(4001) }, 'invalid_command');
    await apply({ type: 'update.add', itemId: parent.id, kind: 'note', body: 'A note does not change the blocker.' });
    await apply({ type: 'update.add', itemId: parent.id, kind: 'blocker', body: 'Direct blocker.' });
    const directBlocker = state.updates.find(update => update.itemId === parent.id && update.kind === 'blocker' && update.body === 'Direct blocker.')!;
    await apply({ type: 'update.add', itemId: parent.id, kind: 'blocker_resolved', body: 'Resolved current blocker.' });
    const resolvedBlocker = state.updates.find(update => update.itemId === parent.id && update.kind === 'blocker_resolved' && update.body === 'Resolved current blocker.')!;
    assert.equal(state.items.find(item => item.id === parent.id)?.blocker, '');
    await apply({ type: 'update.edit', id: resolvedBlocker.id, body: 'Resolution revised.' });
    assert.equal(state.items.find(item => item.id === parent.id)?.blocker, '');
    await apply({ type: 'update.delete', id: resolvedBlocker.id });
    assert.equal(state.items.find(item => item.id === parent.id)?.blocker, 'Direct blocker.');
    await apply({ type: 'update.edit', id: directBlocker.id, body: 'Edited direct blocker.' });
    assert.equal(state.items.find(item => item.id === parent.id)?.blocker, 'Edited direct blocker.');
    await apply({ type: 'update.delete', id: directBlocker.id });
    assert.equal(state.items.find(item => item.id === parent.id)?.blocker, 'Blocked by dependency.');
    await apply({ type: 'update.delete', id: firstBlocker.id });
    assert.equal(state.items.find(item => item.id === parent.id)?.blocker, '');
    await pool.query('INSERT INTO simple_items(id,title,description,workstream_id,parent_id,status,assignee_id,due_date,blocker) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', ['legacy-unassigned', 'Legacy unassigned', '', streamId, null, 'todo', editor.id, null, '']);
    await pool.query('INSERT INTO simple_updates(id,item_id,author_id,body) VALUES($1,$2,$3,$4)', ['legacy-update', 'legacy-unassigned', editor.id, 'Historical note']);
    state = await readWork(admin);
    const legacy = state.items.find(item => item.id === 'legacy-unassigned')!;
    assert.equal((await pool.query('SELECT assignee_id FROM simple_items WHERE id = $1', [legacy.id])).rows[0].assignee_id, editor.id);
    assert.deepEqual(legacy.assigneeIds, []);
    assert.equal(state.updates.find(update => update.id === 'legacy-update')?.assigneeIds, null);
    await apply({ type: 'update.add', itemId: legacy.id, kind: 'note', body: 'Unassigned updates are allowed.' });
    const legacyUpdate = state.updates.find(update => update.itemId === legacy.id && update.body === 'Unassigned updates are allowed.')!;
    assert.deepEqual(legacyUpdate.assigneeIds, []);
    await reject({ type: 'item.create', item: { ...assigned(emptyItem(streamId)), title: 'Grandchild', parentId: child.id } }, 'invalid_parent');
    await reject({ type: 'item.create', item: { ...assigned(emptyItem(other.id)), title: 'Wrong stream', parentId: parent.id } }, 'invalid_parent');
    await reject({ type: 'item.update', id: parent.id, item: { ...input(parent), status: 'done' } }, 'parent_incomplete');
    await reject({ type: 'item.update', id: parent.id, item: { ...input(parent), workstreamId: other.id } }, 'invalid_parent');
    await apply({ type: 'workstream.update', id: streamId, workstream: { title: 'One', description: '', leadId: admin.id, goalIds: [] } });
    assert.deepEqual(state.workstreams.find(stream => stream.id === streamId)?.goalIds, []);
    await apply({ type: 'workstream.update', id: streamId, workstream: { title: 'One', description: '', leadId: admin.id, goalIds: [goalId] } });
    await reject({ type: 'tag.create', tag: { name: 'Shared', description: 'Definition', workstreamId: null } }, 'forbidden', editor);
    await reject({ type: 'tag.create', tag: { name: 'Foreign', description: 'Definition', workstreamId: streamId } }, 'forbidden', editor);
    await reject({ type: 'workstream.update', id: streamId, workstream: { title: 'One', description: '', leadId: editor.id, goalIds: [goalId] } }, 'forbidden', editor);
    await apply({ type: 'tag.create', tag: { name: 'Local', description: 'Definition', workstreamId: other.id } }, editor);
    const tag = state.tags[0];
    await reject({ type: 'tag.update', id: tag.id, tag: { name: tag.name, description: tag.description, workstreamId: null } }, 'forbidden', editor);
    await reject({ type: 'item.update', id: child.id, item: { ...input(child), tagIds: [tag.id] } }, 'unauthorized_tag_change');
    await reject({ type: 'item.update', id: child.id, item: { ...input(child), status: 'done' } }, 'forbidden', { ...viewer, role: 'admin' });
    const rev = state.revision;
    const command: Command = { type: 'item.update', id: child.id, item: { ...input(child), status: 'done' } };
    const results = await Promise.allSettled([executeWork({ expectedRevision: rev, command }, admin), executeWork({ expectedRevision: rev, command }, admin)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal((results.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code, 'revision_conflict');
    state = await readWork(admin);
    await apply({ type: 'item.update', id: parent.id, item: { ...input(parent), status: 'done' } });
    await reject({ type: 'item.create', item: { ...assigned(emptyItem(streamId)), title: 'New unfinished child', parentId: parent.id } }, 'parent_completed');
    await apply({ type: 'update.add', itemId: parent.id, kind: 'note', body: 'Handoff complete.' }, editor);
    const firstUpdate = state.updates.find(update => update.itemId === parent.id && update.body === 'Handoff complete.')!;
    assert.equal(firstUpdate.authorId, editor.id);
    assert.deepEqual(firstUpdate.assigneeIds, [admin.id, editor.id]);
    const reassignedParent = state.items.find(item => item.id === parent.id)!;
    await apply({ type: 'item.update', id: parent.id, item: { ...input(reassignedParent), assigneeIds: [editor.id] } });
    await apply({ type: 'update.add', itemId: parent.id, kind: 'note', body: 'Ownership changed.' }, editor);
    const firstParentUpdate = state.updates.find(update => update.itemId === parent.id && update.body === 'Handoff complete.')!;
    const reassignedParentUpdate = state.updates.find(update => update.itemId === parent.id && update.body === 'Ownership changed.')!;
    assert.deepEqual(firstParentUpdate.assigneeIds, [admin.id, editor.id]);
    assert.deepEqual(reassignedParentUpdate.assigneeIds, [editor.id]);
    assert.equal(reassignedParentUpdate.authorId, editor.id);
    assert.equal(state.changes.length, state.revision);
    await reject({ type: 'goal.delete', id: goalId }, 'entity_in_use');
    await apply({ type: 'goal.create', goal: { title: 'Disposable goal', description: '', targetDate: null } });
    const disposableGoal = state.goals.find(goal => goal.title === 'Disposable goal')!;
    await rejectStale({ type: 'goal.delete', id: disposableGoal.id });
    await reject({ type: 'goal.delete', id: disposableGoal.id }, 'forbidden', viewer);
    await apply({ type: 'goal.delete', id: disposableGoal.id });
    assert.equal(state.goals.some(goal => goal.id === disposableGoal.id), false);

    await reject({ type: 'workstream.delete', id: streamId }, 'entity_in_use');
    await apply({ type: 'workstream.create', workstream: { title: 'Disposable stream', description: '', leadId: null, goalIds: [] } });
    const disposableStream = state.workstreams.find(stream => stream.title === 'Disposable stream')!;
    await rejectStale({ type: 'workstream.delete', id: disposableStream.id });
    await reject({ type: 'workstream.delete', id: disposableStream.id }, 'forbidden', viewer);
    await apply({ type: 'workstream.delete', id: disposableStream.id });
    assert.equal(state.workstreams.some(stream => stream.id === disposableStream.id), false);

    await reject({ type: 'item.delete', id: parent.id }, 'entity_in_use');
    await rejectStale({ type: 'item.delete', id: unassigned.id });
    await reject({ type: 'item.delete', id: unassigned.id }, 'forbidden', viewer);
    await reject({ type: 'item.delete', id: unassigned.id }, 'entity_in_use');
    await apply({ type: 'update.delete', id: legacyBlockerEvent!.id });
    assert.equal(state.items.find(item => item.id === unassigned.id)?.blocker, '');
    await apply({ type: 'item.delete', id: unassigned.id });
    assert.equal(state.items.some(item => item.id === unassigned.id), false);

    await apply({ type: 'item.create', item: { ...emptyItem(other.id), title: 'Tagged item', tagIds: [tag.id] } });
    const taggedItem = state.items.find(item => item.title === 'Tagged item')!;
    const starredTagged = await executeWork({ expectedRevision: state.revision, command: { type: 'item.star', itemId: taggedItem.id, starred: true } }, viewer);
    assert.deepEqual(starredTagged.starredItemIds, [taggedItem.id]);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_item_stars WHERE item_id = $1 AND person_id = $2', [taggedItem.id, viewer.id])).rows[0].count, 1);
    await reject({ type: 'tag.delete', id: tag.id }, 'forbidden', viewer);
    await apply({ type: 'item.delete', id: taggedItem.id });
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_item_stars WHERE item_id = $1', [taggedItem.id])).rows[0].count, 0);
    await apply({ type: 'tag.delete', id: tag.id }, editor);
    assert.equal(state.tags.some(candidate => candidate.id === tag.id), false);

    const originalCreatedAt = firstUpdate.createdAt;
    const originalAssigneeIds = [...(firstUpdate.assigneeIds ?? [])];
    await rejectStale({ type: 'update.edit', id: firstUpdate.id, body: 'stale edit' });
    await reject({ type: 'update.edit', id: firstUpdate.id, body: 'forbidden edit' }, 'forbidden', viewer);
    await apply({ type: 'update.edit', id: firstUpdate.id, body: 'Edited handoff.' }, editor);
    const editedUpdate = state.updates.find(update => update.id === firstUpdate.id)!;
    assert.equal(editedUpdate.authorId, firstUpdate.authorId);
    assert.equal(editedUpdate.createdAt, originalCreatedAt);
    assert.deepEqual(editedUpdate.assigneeIds, originalAssigneeIds);
    await reject({ type: 'update.delete', id: firstUpdate.id }, 'forbidden', viewer);
    await rejectStale({ type: 'update.delete', id: firstUpdate.id });
    await apply({ type: 'update.delete', id: firstUpdate.id }, editor);
    assert.equal(state.updates.some(update => update.id === firstUpdate.id), false);

    await reject({ type: 'person.delete', id: editor.id }, 'forbidden', editor);
    await reject({ type: 'person.delete', id: editor.id }, 'entity_in_use');
    const provisionedStar = await executeWork({ expectedRevision: state.revision, command: { type: 'item.star', itemId: parent.id, starred: true } }, provisioned);
    assert.deepEqual(provisionedStar.starredItemIds, [parent.id]);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_item_stars WHERE item_id = $1 AND person_id = $2', [parent.id, provisioned.id])).rows[0].count, 1);
    await rejectStale({ type: 'person.delete', id: provisioned.id });
    await reject({ type: 'person.delete', id: provisioned.id }, 'forbidden', viewer);
    await apply({ type: 'person.delete', id: provisioned.id });
    assert.equal(state.people.some(person => person.id === provisioned.id), false);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM simple_item_stars WHERE person_id = $1', [provisioned.id])).rows[0].count, 0);
    await reject({ type: 'person.delete', id: admin.id }, 'last_admin');
    await apply({ type: 'person.create', person: { name: 'Second Admin', email: 'second-admin@example.test', role: 'admin' } });
    const secondAdmin = state.people.find(person => person.email === 'second-admin@example.test')!;
    await reject({ type: 'person.delete', id: secondAdmin.id }, 'self_delete', secondAdmin);
    await apply({ type: 'person.delete', id: secondAdmin.id });
    assert.equal(state.people.some(person => person.id === secondAdmin.id), false);
    assert.equal(state.changes.length, state.revision);
  } finally {
    await pool.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
});

test('assignment migration backfills the junction without rewriting legacy attribution', { skip: !process.env.WORK_TEST_DATABASE_URL }, async () => {
  const baseUrl = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `work_migration_test_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: baseUrl.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  baseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const db = new Pool({ connectionString: baseUrl.toString() });
  try {
    for (const file of ['0001_initial.sql', '0002_portfolio.sql', '0003_item_tags.sql', '0004_simple_work.sql']) {
      await db.query(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await db.query("INSERT INTO people(id,name,email,team,role) VALUES('legacy-person','Legacy Person','legacy@example.test','','editor')");
    await db.query("INSERT INTO simple_workstreams(id,title,description) VALUES('legacy-stream','Legacy stream','')");
    await db.query("INSERT INTO simple_items(id,title,description,workstream_id,status,assignee_id,blocker) VALUES('legacy-item','Legacy item','','legacy-stream','todo','legacy-person','Legacy blocker')");
    await db.query("INSERT INTO simple_updates(id,item_id,author_id,body) VALUES('legacy-update','legacy-item','legacy-person','Historical note')");
    await db.query(readFileSync(new URL('../migrations/0005_simple_item_assignees.sql', import.meta.url), 'utf8'));
    await db.query(readFileSync(new URL('../migrations/0006_work_typed_updates_and_stars.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await db.query('SELECT person_id FROM simple_item_assignees WHERE item_id = $1', ['legacy-item'])).rows.map(row => row.person_id), ['legacy-person']);
    assert.equal((await db.query('SELECT assignee_id FROM simple_items WHERE id = $1', ['legacy-item'])).rows[0].assignee_id, 'legacy-person');
    assert.equal((await db.query('SELECT assignee_ids FROM simple_updates WHERE id = $1', ['legacy-update'])).rows[0].assignee_ids, null);
    assert.equal((await db.query('SELECT kind FROM simple_updates WHERE id = $1', ['legacy-update'])).rows[0].kind, 'note');
    assert.equal((await db.query('SELECT blocker_baseline FROM simple_items WHERE id = $1', ['legacy-item'])).rows[0].blocker_baseline, 'Legacy blocker');
    assert.equal((await db.query('SELECT blocker FROM simple_items WHERE id = $1', ['legacy-item'])).rows[0].blocker, 'Legacy blocker');
  } finally {
    await db.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
});

test('item goal and work filter migrations preserve links and saved scopes', { skip: !process.env.WORK_TEST_DATABASE_URL }, async () => {
  const baseUrl = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `work_filter_migration_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: baseUrl.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  baseUrl.searchParams.set('options', `-c search_path=${schema}`);
  const db = new Pool({ connectionString: baseUrl.toString() });
  try {
    for (const file of ['0001_initial.sql', '0002_portfolio.sql', '0003_item_tags.sql', '0004_simple_work.sql']) {
      await db.query(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await db.query("INSERT INTO simple_goals(id,title,description) VALUES ('goal-direct','Direct goal',''),('goal-linked','Existing link',''),('goal-other','Other goal','')");
    await db.query("INSERT INTO people(id,name,email,team,role) VALUES ('legacy-person','Legacy Person','legacy-goal@example.test','','editor'),('other-person','Other Person','other-goal@example.test','','editor'),('no-goal-person','No Goal Person','no-goal@example.test','','editor'),('off-person','Off Person','off-goal@example.test','','editor'),('invalid-person','Invalid Person','invalid-goal@example.test','','editor'),('mixed-person','Mixed Person','mixed-goal@example.test','','editor'),('partial-person','Partial Person','partial-goal@example.test','','editor'),('null-person','Null Person','null-goal@example.test','','editor'),('missing-person','Missing Person','missing-goal@example.test','','editor'),('unknown-person','Unknown Person','unknown-goal@example.test','','editor')");
    await db.query("INSERT INTO people(id,name,email,team,role) VALUES ('search-person','Search Person','search-goal@example.test','','editor')");
    await db.query("INSERT INTO simple_workstreams(id,title,description) VALUES ('legacy-stream','Legacy stream',''),('other-stream','Other stream','')");
    await db.query("INSERT INTO simple_workstream_goals(workstream_id,goal_id) VALUES ('legacy-stream','goal-linked')");
    await db.query("INSERT INTO simple_items(id,title,description,workstream_id,goal_id,status) VALUES ('legacy-item','Legacy item','','legacy-stream','goal-direct','todo'),('linked-item','Linked item','','legacy-stream','goal-linked','todo'),('other-item','Other item','','other-stream','goal-other','doing')");
    for (const file of ['0005_simple_item_assignees.sql', '0006_work_typed_updates_and_stars.sql', '0007_work_assessments.sql', '0008_work_assessments_v2.sql', '0009_work_assessment_scopes.sql']) {
      await db.query(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
    }
    await db.query(`INSERT INTO simple_work_assessment_preferences(person_id,enabled,scope) VALUES
      ('legacy-person',true,'{"workstreamId":"legacy-stream","goalId":"goal-direct","assigneeId":"legacy-person","status":"todo","tagId":"tag-unavailable","search":"","starredOnly":true,"dueTiming":"later"}'),
      ('other-person',true,'{"workstreamId":"other-stream","goalId":"goal-other","assigneeId":"other-person","status":"doing","tagId":"tag-other","search":"","starredOnly":false,"dueTiming":"undated"}'),
      ('no-goal-person',true,'{"workstreamId":"legacy-stream","goalId":"","assigneeId":"missing-person","status":"","tagId":"tag-unavailable","search":"   ","starredOnly":true,"dueTiming":"overdue_or_due_soon"}'),
      ('off-person',false,'{"workstreamId":"","goalId":"","assigneeId":"","status":"","tagId":"","search":"","starredOnly":false,"dueTiming":""}'),
      ('invalid-person',false,'{"workstreamId":7,"goalId":true,"assigneeId":{},"status":["todo"],"tagId":null}'),
      ('mixed-person',true,'{"workstreamId":"legacy-stream","goalId":"","assigneeId":"","status":"","tagId":"","workstreamIds":["already-new"]}'),
      ('partial-person',true,'{"workstreamId":"legacy-stream","goalId":"","assigneeId":"","status":""}'),
      ('null-person',true,NULL),
      ('unknown-person',true,'{"workstreamId":"missing-stream","goalId":"missing-goal","assigneeId":"missing-person","status":"todo","tagId":"missing-tag","unexpected":true}')`);
    await db.query("INSERT INTO simple_work_assessment_preferences(person_id,enabled,scope) VALUES ('search-person',true,'{\"search\":\"Existing link\"}')");
    await db.query("INSERT INTO simple_work_assessment_preferences(person_id,enabled) VALUES ('missing-person',true)");
    await db.query("INSERT INTO simple_work_assessments(item_id,input_key,record) VALUES ('legacy-item', repeat('a', 64), '{\"preserved\":true}')");
    const revisionBefore = (await db.query('SELECT revision FROM simple_workspace WHERE id = 1')).rows[0].revision;
    const changesBefore = (await db.query('SELECT id, actor_id, action, entity_id FROM simple_changes ORDER BY id')).rows;
    const itemsBefore = (await db.query('SELECT id, title, description, workstream_id, status FROM simple_items ORDER BY id')).rows;
    const expectedMembership = { legacy: ['legacy-item'], noGoal: [], off: ['legacy-item', 'linked-item', 'other-item'], other: ['other-item'] };
    await db.query(readFileSync(new URL('../migrations/0010_remove_item_goal.sql', import.meta.url), 'utf8'));
    assert.deepEqual((await db.query('SELECT workstream_id, goal_id FROM simple_workstream_goals ORDER BY workstream_id, goal_id')).rows, [
      { workstream_id: 'legacy-stream', goal_id: 'goal-direct' },
      { workstream_id: 'legacy-stream', goal_id: 'goal-linked' },
      { workstream_id: 'other-stream', goal_id: 'goal-other' },
    ]);
    assert.equal((await db.query('SELECT count(*)::int AS count FROM simple_items')).rows[0].count, 3);
    assert.equal((await db.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'simple_items' AND column_name = 'goal_id'")).rows[0].count, 0);
    assert.deepEqual((await db.query('SELECT record FROM simple_work_assessments WHERE item_id = $1', ['legacy-item'])).rows, [{ record: { preserved: true } }]);
    assert.equal((await db.query("SELECT enabled FROM simple_work_assessment_preferences WHERE person_id = 'legacy-person'")).rows[0].enabled, false);
    assert.equal((await db.query("SELECT enabled FROM simple_work_assessment_preferences WHERE person_id = 'no-goal-person'")).rows[0].enabled, true);
    await db.query(readFileSync(new URL('../migrations/0011_work_filter_multiselect.sql', import.meta.url), 'utf8'));

    assert.deepEqual((await db.query('SELECT person_id, enabled, scope FROM simple_work_assessment_preferences ORDER BY person_id')).rows, [
      { person_id: 'invalid-person', enabled: false, scope: { workstreamIds: [7], goalIds: [true], assigneeIds: [{}], statuses: [['todo']], tagIds: [null] } },
      { person_id: 'legacy-person', enabled: false, scope: { search: '', starredOnly: true, dueTiming: 'later', workstreamIds: ['legacy-stream'], goalIds: ['goal-direct'], assigneeIds: ['legacy-person'], statuses: ['todo'], tagIds: ['tag-unavailable'] } },
      { person_id: 'missing-person', enabled: true, scope: null },
      { person_id: 'mixed-person', enabled: true, scope: { workstreamId: 'legacy-stream', goalId: '', assigneeId: '', status: '', tagId: '', workstreamIds: ['already-new'] } },
      { person_id: 'no-goal-person', enabled: true, scope: { search: '   ', starredOnly: true, dueTiming: 'overdue_or_due_soon', workstreamIds: ['legacy-stream'], goalIds: [], assigneeIds: ['missing-person'], statuses: [], tagIds: ['tag-unavailable'] } },
      { person_id: 'null-person', enabled: true, scope: null },
      { person_id: 'off-person', enabled: false, scope: { search: '', starredOnly: false, dueTiming: '', workstreamIds: [], goalIds: [], assigneeIds: [], statuses: [], tagIds: [] } },
      { person_id: 'other-person', enabled: false, scope: { search: '', starredOnly: false, dueTiming: 'undated', workstreamIds: ['other-stream'], goalIds: ['goal-other'], assigneeIds: ['other-person'], statuses: ['doing'], tagIds: ['tag-other'] } },
      { person_id: 'partial-person', enabled: true, scope: { workstreamId: 'legacy-stream', goalId: '', assigneeId: '', status: '' } },
      { person_id: 'search-person', enabled: false, scope: { search: 'Existing link' } },
      { person_id: 'unknown-person', enabled: false, scope: { workstreamIds: ['missing-stream'], goalIds: ['missing-goal'], assigneeIds: ['missing-person'], statuses: ['todo'], tagIds: ['missing-tag'], unexpected: true } },
    ]);
    const predicateSnapshot: Snapshot = {
      revision: 0,
      demo: false,
      people: [
        { id: 'legacy-person', name: 'Legacy Person', email: 'legacy@example.test', role: 'editor' },
        { id: 'other-person', name: 'Other Person', email: 'other@example.test', role: 'editor' },
        { id: 'missing-person', name: 'Missing Person', email: 'missing@example.test', role: 'editor' },
      ],
      goals: [
        { id: 'goal-direct', title: 'Direct goal', description: '', targetDate: null },
        { id: 'goal-linked', title: 'Existing link', description: '', targetDate: null },
        { id: 'goal-other', title: 'Other goal', description: '', targetDate: null },
      ],
      workstreams: [
        { id: 'legacy-stream', title: 'Legacy stream', description: '', leadId: null, goalIds: ['goal-direct', 'goal-linked'] },
        { id: 'other-stream', title: 'Other stream', description: '', leadId: null, goalIds: ['goal-other'] },
      ],
      items: [
        { ...emptyItem('legacy-stream'), id: 'legacy-item', title: 'Legacy item', status: 'todo', assigneeIds: ['legacy-person'], dueDate: '2026-10-03', tagIds: ['tag-unavailable'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' },
        { ...emptyItem('legacy-stream'), id: 'linked-item', title: 'Linked item', status: 'todo', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' },
        { ...emptyItem('other-stream'), id: 'other-item', title: 'Other item', status: 'doing', assigneeIds: ['other-person'], tagIds: ['tag-other'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' },
      ],
      tags: [
        { id: 'tag-unavailable', name: 'Unavailable tag', description: '', workstreamId: null },
        { id: 'tag-other', name: 'Other tag', description: '', workstreamId: null },
      ],
      updates: [],
      changes: [],
      starredItemIds: ['legacy-item'],
    };
    const actualMembership = (filters: WorkFilters) => predicateSnapshot.items
      .filter(item => matchesBaseWorkFilters(item, predicateSnapshot, filters, 'all', 'legacy-person', '2026-09-28'))
      .map(item => item.id);
    const convertedScopes = {
      legacy: workFiltersSchema.parse((await db.query("SELECT scope FROM simple_work_assessment_preferences WHERE person_id = 'legacy-person'")).rows[0].scope),
      noGoal: workFiltersSchema.parse((await db.query("SELECT scope FROM simple_work_assessment_preferences WHERE person_id = 'no-goal-person'")).rows[0].scope),
      off: workFiltersSchema.parse((await db.query("SELECT scope FROM simple_work_assessment_preferences WHERE person_id = 'off-person'")).rows[0].scope),
      other: workFiltersSchema.parse((await db.query("SELECT scope FROM simple_work_assessment_preferences WHERE person_id = 'other-person'")).rows[0].scope),
    };
    assert.deepEqual({
      legacy: actualMembership(convertedScopes.legacy),
      noGoal: actualMembership(convertedScopes.noGoal),
      off: actualMembership(convertedScopes.off),
      other: actualMembership(convertedScopes.other),
    }, expectedMembership, 'converted scopes preserve expected item memberships through the shared predicate');
    assert.deepEqual(actualMembership({ ...convertedScopes.legacy, search: 'Legacy item' }), ['legacy-item']);
    assert.equal((await db.query('SELECT revision FROM simple_workspace WHERE id = 1')).rows[0].revision, revisionBefore);
    assert.deepEqual((await db.query('SELECT id, actor_id, action, entity_id FROM simple_changes ORDER BY id')).rows, changesBefore);
    assert.deepEqual((await db.query('SELECT id, title, description, workstream_id, status FROM simple_items ORDER BY id')).rows, itemsBefore);
    for (const personId of ['invalid-person', 'mixed-person', 'partial-person', 'null-person', 'missing-person', 'unknown-person']) {
      const scope = (await db.query('SELECT scope FROM simple_work_assessment_preferences WHERE person_id = $1', [personId])).rows[0].scope;
      assert.throws(() => assessmentScopeSchema.parse(scope), `malformed scope for ${personId} must remain rejected`);
    }
    assert.throws(() => itemInputSchema.parse({ ...emptyItem('legacy-stream'), goalId: 'goal-direct' }));
  } finally {
    await db.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
});
