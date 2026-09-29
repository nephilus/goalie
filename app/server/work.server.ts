import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { commandRequestSchema, personInputSchema, snapshotSchema, type Change, type Command, type CommandRequest, type Goal, type Item, type ItemInput, type Person, type PersonInput, type Snapshot, type Tag, type TagInput, type Update, type Workstream, type WorkstreamInput } from '../shared/work';
import { pool, withTransaction } from './db.server';

export class WorkError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 422, code = 'invalid_work') {
    super(message);
    this.name = 'WorkError';
    this.status = status;
    this.code = code;
  }
}

type Row = Record<string, any>;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const id = (): string => randomUUID();

async function currentActor(client: PoolClient, actor: Person): Promise<Person> {
  const result = await client.query<Row>('SELECT id, name, email, role FROM people WHERE id = $1', [actor.id]);
  const row = result.rows[0];
  if (!row) throw new WorkError('Your account is no longer provisioned.', 403, 'forbidden');
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

function mapGoal(row: Row): Goal {
  return { id: row.id, title: row.title, description: row.description, targetDate: row.target_date };
}
function mapStream(row: Row, goalIds: string[]): Workstream {
  return { id: row.id, title: row.title, description: row.description, leadId: row.lead_id, goalIds };
}
function mapItem(row: Row, tagIds: string[], assigneeIds: string[]): Item {
  return { id: row.id, title: row.title, description: row.description, workstreamId: row.workstream_id, parentId: row.parent_id, status: row.status, assigneeIds, dueDate: row.due_date, blocker: row.blocker, tagIds, updatedAt: iso(row.updated_at), createdAt: iso(row.created_at) };
}
function mapTag(row: Row): Tag {
  return { id: row.id, name: row.name, description: row.description, workstreamId: row.workstream_id };
}

async function selectSnapshot(client: PoolClient, actorId: string): Promise<Snapshot> {
  const workspace = (await client.query<Row>('SELECT revision, demo FROM simple_workspace WHERE id = 1')).rows[0];
  if (!workspace) throw new WorkError('Simple workspace is not initialized; run database migration.', 503, 'database_uninitialized');
  const people = await client.query<Row>('SELECT id, name, email, role FROM people ORDER BY lower(name), id');
  const goals = await client.query<Row>('SELECT id, title, description, target_date FROM simple_goals ORDER BY lower(title), id');
  const streams = await client.query<Row>('SELECT id, title, description, lead_id FROM simple_workstreams ORDER BY lower(title), id');
  const streamGoals = await client.query<Row>('SELECT workstream_id, goal_id FROM simple_workstream_goals ORDER BY workstream_id, goal_id');
  const items = await client.query<Row>('SELECT id, title, description, workstream_id, parent_id, status, due_date, blocker, created_at, updated_at FROM simple_items ORDER BY lower(title), id');
  const itemTags = await client.query<Row>('SELECT item_id, tag_id FROM simple_item_tags ORDER BY item_id, tag_id');
  const itemAssignees = await client.query<Row>('SELECT item_id, person_id FROM simple_item_assignees ORDER BY item_id, person_id');
  const tags = await client.query<Row>('SELECT id, name, description, workstream_id FROM simple_tags ORDER BY lower(name), id');
  const updates = await client.query<Row>('SELECT id, item_id, author_id, body, kind, assignee_ids, created_at FROM simple_updates ORDER BY created_at, id');
  const changes = await client.query<Row>('SELECT id, actor_id, action, entity_id, created_at FROM simple_changes ORDER BY created_at, id');
  const starredItems = await client.query<Row>('SELECT item_id FROM simple_item_stars WHERE person_id = $1 ORDER BY item_id', [actorId]);
  const streamGoalIds = new Map<string, string[]>();
  for (const row of streamGoals.rows) streamGoalIds.set(row.workstream_id, [...(streamGoalIds.get(row.workstream_id) ?? []), row.goal_id]);
  const itemTagIds = new Map<string, string[]>();
  for (const row of itemTags.rows) itemTagIds.set(row.item_id, [...(itemTagIds.get(row.item_id) ?? []), row.tag_id]);
  const itemAssigneeIds = new Map<string, string[]>();
  for (const row of itemAssignees.rows) itemAssigneeIds.set(row.item_id, [...(itemAssigneeIds.get(row.item_id) ?? []), row.person_id]);
  const snapshot = {
    revision: Number(workspace.revision), demo: Boolean(workspace.demo),
    people: people.rows.map(row => ({ id: row.id, name: row.name, email: row.email, role: row.role })),
    goals: goals.rows.map(mapGoal),
    workstreams: streams.rows.map(row => mapStream(row, streamGoalIds.get(row.id) ?? [])),
    items: items.rows.map(row => mapItem(row, itemTagIds.get(row.id) ?? [], itemAssigneeIds.get(row.id) ?? [])),
    tags: tags.rows.map(mapTag),
    updates: updates.rows.map(row => ({ id: row.id, itemId: row.item_id, authorId: row.author_id, body: row.body, kind: row.kind, assigneeIds: row.assignee_ids, createdAt: iso(row.created_at) })),
    changes: changes.rows.map(row => ({ id: row.id, actorId: row.actor_id, action: row.action, entityId: row.entity_id, createdAt: iso(row.created_at) })),
    starredItemIds: starredItems.rows.map(row => row.item_id),
  } satisfies Snapshot;
  return snapshotSchema.parse(snapshot);
}

export async function readWorkInTransaction(client: PoolClient, actor: Person): Promise<Snapshot> {
  const current = await currentActor(client, actor);
  return selectSnapshot(client, current.id);
}

export async function readWork(actor: Person): Promise<Snapshot> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = await readWorkInTransaction(client, actor);
    await client.query('COMMIT');
    return snapshot;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
  }
}


async function oneExists(client: PoolClient, table: string, value: string): Promise<boolean> {
  const result = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [value]);
  return result.rowCount === 1;
}
async function assertPeople(client: PoolClient, ids: Array<string | null>): Promise<void> {
  const wanted = [...new Set(ids.filter((value): value is string => Boolean(value)))];
  if (!wanted.length) return;
  const rows = await client.query<Row>('SELECT id FROM people WHERE id = ANY($1::text[])', [wanted]);
  if (rows.rowCount !== wanted.length) throw new WorkError('A referenced person does not exist.', 422, 'invalid_reference');
}
async function assertIds(client: PoolClient, table: string, ids: string[], label: string): Promise<void> {
  if (!ids.length) return;
  const unique = [...new Set(ids)];
  const rows = await client.query<Row>(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`, [unique]);
  if (rows.rowCount !== unique.length) throw new WorkError(`${label} references a record that does not exist.`, 422, 'invalid_reference');
}
async function assertGoalIds(client: PoolClient, ids: string[]): Promise<void> { await assertIds(client, 'simple_goals', ids, 'Workstream goals'); }

async function assertTagLinks(client: PoolClient, tagIds: string[], workstreamId: string): Promise<void> {
  if (!tagIds.length) return;
  const rows = await client.query<Row>('SELECT id, workstream_id FROM simple_tags WHERE id = ANY($1::text[])', [tagIds]);
  if (rows.rowCount !== new Set(tagIds).size) throw new WorkError('Item references a tag that does not exist.', 422, 'invalid_tag_reference');
  if (rows.rows.some(row => row.workstream_id !== null && row.workstream_id !== workstreamId)) {
    throw new WorkError('A tag is restricted to a different workstream.', 403, 'unauthorized_tag_change');
  }
}

async function assertParentAndCompletion(client: PoolClient, input: ItemInput, itemId: string | null): Promise<void> {
  if (input.parentId) {
    if (itemId && input.parentId === itemId) throw new WorkError('An item cannot be its own parent.', 422, 'invalid_parent');
    const parent = (await client.query<Row>('SELECT id, workstream_id, status, parent_id FROM simple_items WHERE id = $1', [input.parentId])).rows[0];
    if (!parent) throw new WorkError('Parent item does not exist.', 422, 'invalid_reference');
    if (parent.workstream_id !== input.workstreamId) throw new WorkError('Parent and child must belong to the same workstream.', 422, 'invalid_parent');
    if (parent.parent_id) throw new WorkError('Only one level of subtasks is supported.', 422, 'invalid_parent');
    if (parent.status === 'done' && input.status !== 'done') throw new WorkError('A completed parent cannot receive unfinished children.', 422, 'parent_completed');
    if (itemId && (await client.query('SELECT 1 FROM simple_items WHERE parent_id = $1 LIMIT 1', [itemId])).rowCount) {
      throw new WorkError('A parent with subtasks cannot itself become a subtask.', 422, 'invalid_parent');
    }
  }
  if (itemId && (await client.query('SELECT 1 FROM simple_items WHERE parent_id = $1 AND workstream_id <> $2 LIMIT 1', [itemId, input.workstreamId])).rowCount) {
    throw new WorkError('Move or detach subtasks before changing their parent workstream.', 422, 'invalid_parent');
  }
  if (input.status === 'done') {
    const openChildren = await client.query<Row>("SELECT 1 FROM simple_items WHERE parent_id = $1 AND status <> 'done' LIMIT 1", [itemId ?? '']);
    if (openChildren.rowCount) throw new WorkError('A parent cannot be completed while a child is unfinished.', 422, 'parent_incomplete');
  }
}

async function assertItemInput(client: PoolClient, input: ItemInput, itemId: string | null): Promise<void> {
  if (!await oneExists(client, 'simple_workstreams', input.workstreamId)) throw new WorkError('Workstream does not exist.', 422, 'invalid_reference');
  await assertPeople(client, input.assigneeIds);
  await assertTagLinks(client, input.tagIds, input.workstreamId);
  await assertParentAndCompletion(client, input, itemId);
}

async function replaceStreamGoals(client: PoolClient, streamId: string, goalIds: string[]): Promise<void> {
  await assertGoalIds(client, goalIds);
  await client.query('DELETE FROM simple_workstream_goals WHERE workstream_id = $1', [streamId]);
  for (const goalId of goalIds) await client.query('INSERT INTO simple_workstream_goals(workstream_id, goal_id) VALUES($1, $2)', [streamId, goalId]);
}
async function replaceItemAssignees(client: PoolClient, itemId: string, assigneeIds: string[]): Promise<void> {
  await client.query('DELETE FROM simple_item_assignees WHERE item_id = $1', [itemId]);
  for (const personId of assigneeIds) await client.query('INSERT INTO simple_item_assignees(item_id, person_id) VALUES($1, $2)', [itemId, personId]);
}
async function replaceItemTags(client: PoolClient, itemId: string, tagIds: string[]): Promise<void> {
  await client.query('DELETE FROM simple_item_tags WHERE item_id = $1', [itemId]);
  for (const tagId of tagIds) await client.query('INSERT INTO simple_item_tags(item_id, tag_id) VALUES($1, $2)', [itemId, tagId]);
}
async function insertChange(client: PoolClient, actorId: string, action: string, entityId: string): Promise<void> {
  await client.query('INSERT INTO simple_changes(id, actor_id, action, entity_id) VALUES($1, $2, $3, $4)', [id(), actorId, action, entityId]);
}
async function insertUpdate(client: PoolClient, itemId: string, authorId: string, body: string, kind: Update['kind']): Promise<string> {
  const assignees = await client.query<Row>('SELECT person_id FROM simple_item_assignees WHERE item_id = $1 ORDER BY person_id', [itemId]);
  const updateId = id();
  await client.query('INSERT INTO simple_updates(id, item_id, author_id, body, kind, assignee_ids) VALUES($1, $2, $3, $4, $5, $6)', [updateId, itemId, authorId, body, kind, assignees.rows.map(row => row.person_id)]);
  return updateId;
}

async function recomputeCurrentBlocker(client: PoolClient, itemId: string): Promise<void> {
  const latest = (await client.query<Row>("SELECT kind, body FROM simple_updates WHERE item_id = $1 AND kind IN ('blocker', 'blocker_resolved') ORDER BY created_at DESC, id DESC LIMIT 1", [itemId])).rows[0];
  const fallback = (await client.query<Row>('SELECT blocker_baseline FROM simple_items WHERE id = $1', [itemId])).rows[0];
  if (!fallback) throw new WorkError('Item does not exist.', 404, 'not_found');
  const blocker = latest ? latest.kind === 'blocker' ? latest.body : '' : fallback.blocker_baseline;
  await client.query('UPDATE simple_items SET blocker = $2, updated_at = now() WHERE id = $1', [itemId, blocker]);
}
function assertEditor(actor: Person): void {
  if (actor.role === 'viewer') throw new WorkError('Editors or administrators are required for this operation.', 403, 'forbidden');
}

function assertAdmin(actor: Person): void {
  if (actor.role !== 'admin') throw new WorkError('Administrators are required for this operation.', 403, 'forbidden');
}

async function assertTagOwner(client: PoolClient, actor: Person, streamId: string | null): Promise<void> {
  if (actor.role === 'admin') return;
  if (!streamId || !(await client.query('SELECT 1 FROM simple_workstreams WHERE id = $1 AND lead_id = $2', [streamId, actor.id])).rowCount) {
    throw new WorkError('Only the workstream lead or an administrator can manage this tag catalogue.', 403, 'forbidden');
  }
}
type Reference = { label: string; query: string };

async function assertNotReferenced(client: PoolClient, entityName: string, entityId: string, references: Reference[]): Promise<void> {
  const details: string[] = [];
  for (const reference of references) {
    const result = await client.query<Row>(reference.query, [entityId]);
    const count = Number(result.rows[0]?.count ?? 0);
    if (count > 0) details.push(`${count} ${reference.label}`);
  }
  if (details.length) {
    throw new WorkError(`Cannot delete this ${entityName}; ${details.join(' and ')} still reference it. Resolve those references first.`, 409, 'entity_in_use');
  }
}

async function assertUpdateEditor(client: PoolClient, actor: Person, updateId: string): Promise<Row> {
  const existing = (await client.query<Row>('SELECT author_id, item_id, kind FROM simple_updates WHERE id = $1', [updateId])).rows[0];
  if (!existing) throw new WorkError('Update does not exist.', 404, 'not_found');
  if (actor.role !== 'admin' && existing.author_id !== actor.id) {
    throw new WorkError('Only the update author or an administrator can edit or delete this update.', 403, 'forbidden');
  }
  return existing;
}

async function assertPersonDeletable(client: PoolClient, actor: Person, personId: string): Promise<void> {
  const existing = (await client.query<Row>('SELECT role FROM people WHERE id = $1', [personId])).rows[0];
  if (!existing) throw new WorkError('Person does not exist.', 404, 'not_found');
  if (existing.role === 'admin') {
    const admins = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM people WHERE role = \'admin\'');
    if (Number(admins.rows[0]?.count ?? 0) <= 1) throw new WorkError('The last administrator cannot be deleted.', 422, 'last_admin');
  }
  if (personId === actor.id) throw new WorkError('You cannot delete your own account.', 422, 'self_delete');
  await assertNotReferenced(client, 'person', personId, [
    { label: 'workstream lead assignment(s)', query: 'SELECT count(*)::int AS count FROM simple_workstreams WHERE lead_id = $1' },
    { label: 'legacy item assignee assignment(s)', query: 'SELECT count(*)::int AS count FROM simple_items WHERE assignee_id = $1' },
    { label: 'item assignee assignment(s)', query: 'SELECT count(*)::int AS count FROM simple_item_assignees WHERE person_id = $1' },
    { label: 'work update author record(s)', query: 'SELECT count(*)::int AS count FROM simple_updates WHERE author_id = $1' },
    { label: 'work update assignee snapshot(s)', query: 'SELECT count(*)::int AS count FROM simple_updates WHERE $1 = ANY(assignee_ids)' },
    { label: 'work audit actor record(s)', query: 'SELECT count(*)::int AS count FROM simple_changes WHERE actor_id = $1' },
    { label: 'legacy workstream owner record(s)', query: 'SELECT count(*)::int AS count FROM workstreams WHERE owner_id = $1' },
    { label: 'legacy item owner record(s)', query: 'SELECT count(*)::int AS count FROM items WHERE owner_id = $1' },
    { label: 'legacy item assignment(s)', query: 'SELECT count(*)::int AS count FROM assignments WHERE person_id = $1' },
    { label: 'legacy update author record(s)', query: 'SELECT count(*)::int AS count FROM updates WHERE author_id = $1' },
    { label: 'legacy audit actor record(s)', query: 'SELECT count(*)::int AS count FROM audit_changes WHERE actor_id = $1' },
    { label: 'portfolio outcome owner record(s)', query: 'SELECT count(*)::int AS count FROM outcomes WHERE owner_id = $1' },
    { label: 'portfolio decision owner record(s)', query: 'SELECT count(*)::int AS count FROM portfolio_decisions WHERE owner_id = $1' },
    { label: 'portfolio decision author record(s)', query: 'SELECT count(*)::int AS count FROM portfolio_decisions WHERE decided_by = $1' },
  ]);
}

function postgresErrorDetails(error: unknown): { code?: string; constraint?: string } {
  if (typeof error !== 'object' || error === null) return {};
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const constraint = 'constraint' in error && typeof error.constraint === 'string' ? error.constraint : undefined;
  return { code, constraint };
}
function mapDbError(error: unknown): never {
  if (error instanceof WorkError) throw error;
  const { code, constraint } = postgresErrorDetails(error);
  if (code === '23505' && constraint === 'people_email_lower_unique') throw new WorkError('A person with that email is already provisioned.', 422, 'duplicate_email');
  if (code === '23505') throw new WorkError('A record with that identifier already exists.', 422, 'collision');
  if (code === '23503') throw new WorkError('A referenced record does not exist.', 422, 'invalid_reference');
  if (code === '23514') throw new WorkError('The record violates a domain invariant.', 422, 'invalid_domain');
  throw error;
}

async function applyCommand(client: PoolClient, command: Command, actor: Person): Promise<string> {
  switch (command.type) {
    case 'goal.create': {
      const record = command.goal;
      const entityId = id();
      await client.query('INSERT INTO simple_goals(id, title, description, target_date) VALUES($1, $2, $3, $4)', [entityId, record.title, record.description, record.targetDate]);
      return entityId;
    }
    case 'goal.update': {
      const record = command.goal;
      const result = await client.query('UPDATE simple_goals SET title = $2, description = $3, target_date = $4, updated_at = now() WHERE id = $1', [command.id, record.title, record.description, record.targetDate]);
      if (!result.rowCount) throw new WorkError('Goal does not exist.', 404, 'not_found');
      return command.id;
    }
    case 'goal.delete': {
      if (!await oneExists(client, 'simple_goals', command.id)) throw new WorkError('Goal does not exist.', 404, 'not_found');
      await assertNotReferenced(client, 'goal', command.id, [
        { label: 'workstream goal link(s)', query: 'SELECT count(*)::int AS count FROM simple_workstream_goals WHERE goal_id = $1' },
      ]);
      await client.query('DELETE FROM simple_goals WHERE id = $1', [command.id]);
      return command.id;
    }
    case 'workstream.create': {
      const record = command.workstream;
      await assertPeople(client, [record.leadId]);
      const entityId = id();
      await client.query('INSERT INTO simple_workstreams(id, title, description, lead_id) VALUES($1, $2, $3, $4)', [entityId, record.title, record.description, record.leadId]);
      await replaceStreamGoals(client, entityId, record.goalIds);
      return entityId;
    }
    case 'workstream.update': {
      const record = command.workstream;
      const previous = (await client.query<Row>('SELECT lead_id FROM simple_workstreams WHERE id = $1', [command.id])).rows[0];
      if (!previous) throw new WorkError('Workstream does not exist.', 404, 'not_found');
      if (previous.lead_id !== record.leadId && actor.role !== 'admin') {
        throw new WorkError('Only an administrator can change workstream leadership.', 403, 'forbidden');
      }
      await assertPeople(client, [record.leadId]);
      const result = await client.query('UPDATE simple_workstreams SET title = $2, description = $3, lead_id = $4, updated_at = now() WHERE id = $1', [command.id, record.title, record.description, record.leadId]);
      if (!result.rowCount) throw new WorkError('Workstream does not exist.', 404, 'not_found');
      await replaceStreamGoals(client, command.id, record.goalIds);
      return command.id;
    }
    case 'workstream.delete': {
      if (!await oneExists(client, 'simple_workstreams', command.id)) throw new WorkError('Workstream does not exist.', 404, 'not_found');
      await assertNotReferenced(client, 'workstream', command.id, [
        { label: 'work item(s)', query: 'SELECT count(*)::int AS count FROM simple_items WHERE workstream_id = $1' },
        { label: 'scoped tag(s)', query: 'SELECT count(*)::int AS count FROM simple_tags WHERE workstream_id = $1' },
      ]);
      await client.query('DELETE FROM simple_workstream_goals WHERE workstream_id = $1', [command.id]);
      await client.query('DELETE FROM simple_workstreams WHERE id = $1', [command.id]);
      return command.id;
    }
    case 'item.create': {
      const record = command.item;
      await assertItemInput(client, record, null);
      const entityId = id();
      await client.query('INSERT INTO simple_items(id, title, description, workstream_id, parent_id, status, due_date, blocker) VALUES($1, $2, $3, $4, $5, $6, $7, $8)', [entityId, record.title, record.description, record.workstreamId, record.parentId, record.status, record.dueDate, record.blocker]);
      await replaceItemAssignees(client, entityId, record.assigneeIds);
      await replaceItemTags(client, entityId, record.tagIds);
      if (record.blocker) await insertUpdate(client, entityId, actor.id, record.blocker, 'blocker');
      return entityId;
    }
    case 'item.update': {
      const record = command.item;
      const previous = (await client.query<Row>('SELECT blocker FROM simple_items WHERE id = $1', [command.id])).rows[0];
      if (!previous) throw new WorkError('Item does not exist.', 404, 'not_found');
      await assertItemInput(client, record, command.id);
      const result = await client.query('UPDATE simple_items SET title = $2, description = $3, workstream_id = $4, parent_id = $5, status = $6, due_date = $7, blocker = $8, updated_at = now() WHERE id = $1', [command.id, record.title, record.description, record.workstreamId, record.parentId, record.status, record.dueDate, record.blocker]);
      if (!result.rowCount) throw new WorkError('Item does not exist.', 404, 'not_found');
      await replaceItemAssignees(client, command.id, record.assigneeIds);
      await replaceItemTags(client, command.id, record.tagIds);
      if (previous.blocker !== record.blocker) await insertUpdate(client, command.id, actor.id, record.blocker || 'Blocker resolved', record.blocker ? 'blocker' : 'blocker_resolved');
      return command.id;
    }
    case 'item.delete': {
      if (!await oneExists(client, 'simple_items', command.id)) throw new WorkError('Item does not exist.', 404, 'not_found');
      await assertNotReferenced(client, 'item', command.id, [
        { label: 'child item(s)', query: 'SELECT count(*)::int AS count FROM simple_items WHERE parent_id = $1' },
        { label: 'work update(s)', query: 'SELECT count(*)::int AS count FROM simple_updates WHERE item_id = $1' },
      ]);
      await client.query('DELETE FROM simple_item_assignees WHERE item_id = $1', [command.id]);
      await client.query('DELETE FROM simple_item_tags WHERE item_id = $1', [command.id]);
      await client.query('DELETE FROM simple_items WHERE id = $1', [command.id]);
      return command.id;
    }
    case 'item.star': {
      if (!await oneExists(client, 'simple_items', command.itemId)) throw new WorkError('Item does not exist.', 404, 'not_found');
      if (command.starred) {
        await client.query('INSERT INTO simple_item_stars(item_id, person_id) VALUES($1, $2) ON CONFLICT (item_id, person_id) DO NOTHING', [command.itemId, actor.id]);
      } else {
        await client.query('DELETE FROM simple_item_stars WHERE item_id = $1 AND person_id = $2', [command.itemId, actor.id]);
      }
      return command.itemId;
    }
    case 'tag.create': {
      const record = command.tag;
      await assertTagOwner(client, actor, record.workstreamId);
      await assertIds(client, 'simple_workstreams', record.workstreamId ? [record.workstreamId] : [], 'Tag workstream');
      const entityId = id();
      await client.query('INSERT INTO simple_tags(id, name, description, workstream_id) VALUES($1, $2, $3, $4)', [entityId, record.name, record.description, record.workstreamId]);
      return entityId;
    }
    case 'tag.update': {
      const record = command.tag;
      const previous = (await client.query<Row>('SELECT workstream_id FROM simple_tags WHERE id = $1', [command.id])).rows[0];
      if (!previous) throw new WorkError('Tag does not exist.', 404, 'not_found');
      await assertTagOwner(client, actor, previous.workstream_id);
      await assertTagOwner(client, actor, record.workstreamId);
      await assertIds(client, 'simple_workstreams', record.workstreamId ? [record.workstreamId] : [], 'Tag workstream');
      const attached = await client.query<Row>('SELECT i.workstream_id FROM simple_items i JOIN simple_item_tags it ON it.item_id = i.id WHERE it.tag_id = $1', [command.id]);
      if (!attached.rowCount) {
        const exists = await oneExists(client, 'simple_tags', command.id);
        if (!exists) throw new WorkError('Tag does not exist.', 404, 'not_found');
      }
      if (record.workstreamId && attached.rows.some(row => row.workstream_id !== record.workstreamId)) throw new WorkError('Tag is already assigned to a different workstream item.', 403, 'unauthorized_tag_change');
      const result = await client.query('UPDATE simple_tags SET name = $2, description = $3, workstream_id = $4, updated_at = now() WHERE id = $1', [command.id, record.name, record.description, record.workstreamId]);
      if (!result.rowCount) throw new WorkError('Tag does not exist.', 404, 'not_found');
      return command.id;
    }
    case 'tag.delete': {
      const previous = (await client.query<Row>('SELECT workstream_id FROM simple_tags WHERE id = $1', [command.id])).rows[0];
      if (!previous) throw new WorkError('Tag does not exist.', 404, 'not_found');
      await assertTagOwner(client, actor, previous.workstream_id);
      await assertNotReferenced(client, 'tag', command.id, [
        { label: 'item tag link(s)', query: 'SELECT count(*)::int AS count FROM simple_item_tags WHERE tag_id = $1' },
      ]);
      await client.query('DELETE FROM simple_tags WHERE id = $1', [command.id]);
      return command.id;
    }
    case 'person.create': {
      assertAdmin(actor);
      const record: PersonInput = personInputSchema.parse(command.person);
      const entityId = id();
      await client.query('INSERT INTO people(id, name, email, team, role) VALUES($1, $2, $3, \'\', $4)', [entityId, record.name, record.email, record.role]);
      return entityId;
    }
    case 'person.update': {
      assertAdmin(actor);
      const record: PersonInput = personInputSchema.parse(command.person);
      const existing = (await client.query<Row>('SELECT email, role FROM people WHERE id = $1', [command.id])).rows[0];
      if (!existing) throw new WorkError('Person does not exist.', 404, 'not_found');
      if (record.email !== String(existing.email).trim().toLowerCase()) {
        throw new WorkError('A person email cannot be changed after provisioning.', 422, 'email_immutable');
      }
      if (existing.role === 'admin' && record.role !== 'admin') {
        const admins = await client.query<{ count: string }>('SELECT count(*)::text AS count FROM people WHERE role = \'admin\'');
        if (Number(admins.rows[0]?.count ?? 0) <= 1) throw new WorkError('The last administrator cannot be demoted.', 422, 'last_admin');
      }
      await client.query('UPDATE people SET name = $1, role = $2 WHERE id = $3', [record.name, record.role, command.id]);
      return command.id;
    }
    case 'person.delete': {
      assertAdmin(actor);
      await assertPersonDeletable(client, actor, command.id);
      await client.query('DELETE FROM people WHERE id = $1', [command.id]);
      return command.id;
    }
    case 'update.add': {
      if (!await oneExists(client, 'simple_items', command.itemId)) throw new WorkError('Item does not exist.', 404, 'not_found');
      if (command.kind === 'blocker') await client.query('UPDATE simple_items SET blocker = $2, updated_at = now() WHERE id = $1', [command.itemId, command.body]);
      if (command.kind === 'blocker_resolved') await client.query("UPDATE simple_items SET blocker = '', updated_at = now() WHERE id = $1", [command.itemId]);
      await insertUpdate(client, command.itemId, actor.id, command.body, command.kind);
      return command.itemId;
    }
    case 'update.edit': {
      const existing = await assertUpdateEditor(client, actor, command.id);
      if (existing.kind === 'blocker' && command.body.length > 4000) throw new WorkError('Blocker updates cannot exceed 4000 characters.', 422, 'invalid_command');
      const result = await client.query('UPDATE simple_updates SET body = $2 WHERE id = $1', [command.id, command.body]);
      if (!result.rowCount) throw new WorkError('Update does not exist.', 404, 'not_found');
      if (existing.kind === 'blocker' || existing.kind === 'blocker_resolved') await recomputeCurrentBlocker(client, existing.item_id);
      return command.id;
    }
    case 'update.delete': {
      const existing = await assertUpdateEditor(client, actor, command.id);
      const result = await client.query('DELETE FROM simple_updates WHERE id = $1', [command.id]);
      if (!result.rowCount) throw new WorkError('Update does not exist.', 404, 'not_found');
      if (existing.kind === 'blocker' || existing.kind === 'blocker_resolved') await recomputeCurrentBlocker(client, existing.item_id);
      return command.id;
    }
  }
}

export async function executeWork(request: CommandRequest, actor: Person): Promise<Snapshot> {
  let parsed: CommandRequest;
  try { parsed = commandRequestSchema.parse(request); } catch (error) { throw new WorkError(error instanceof Error ? error.message : 'Invalid work command.', 422, 'invalid_command'); }
  try {
    return await withTransaction(async client => {
      const personalOnly = parsed.command.type === 'item.star';
      const workspace = (await client.query<Row>(`SELECT revision FROM simple_workspace WHERE id = 1${personalOnly ? '' : ' FOR UPDATE'}`)).rows[0];
      if (!workspace) throw new WorkError('Simple workspace is not initialized; run database migration.', 503, 'database_uninitialized');
      const current = await currentActor(client, actor);
      if (!personalOnly) {
        assertEditor(current);
        const revision = Number(workspace.revision);
        if (parsed.expectedRevision !== revision) throw new WorkError(`Workspace changed; expected revision ${parsed.expectedRevision}, current revision ${revision}.`, 409, 'revision_conflict');
      }
      const entityId = await applyCommand(client, parsed.command, current);
      if (!personalOnly) {
        await insertChange(client, current.id, parsed.command.type, entityId);
        await client.query('UPDATE simple_workspace SET revision = revision + 1, updated_at = now() WHERE id = 1');
      }
      return await selectSnapshot(client, current.id);
    });
  } catch (error) {
    return mapDbError(error);
  }
}
