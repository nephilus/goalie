import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { adrCommandRequestSchema, adrHistoryEntrySchema, adrHistoryQuerySchema, adrListQuerySchema, adrSchema, notificationListQuerySchema, workNotificationSchema, type Adr, type AdrCommandRequest, type AdrCreateInput, type AdrUpdateInput, type AdrHistoryEntry, type AdrHistoryQuery, type AdrIdentity, type AdrListQuery, type AdrMutationResult, type AdrPage, type NotificationListQuery, type WorkNotification } from '../shared/adr';
import { personSchema, type Person } from '../shared/work';
import { withTransaction } from './db.server';
import { WorkError } from './work.server';

type Row = Record<string, unknown>;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const identifierSchema = z.string().trim().min(1).max(100);
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new WorkError(result.error.message, 422, 'invalid_command');
  return result.data;
}
async function currentActor(client: PoolClient, actor: Person): Promise<Person> {
  const row = (await client.query('SELECT id, name, email, role FROM people WHERE id = $1', [actor.id])).rows[0];
  if (!row) throw new WorkError('Your account is no longer provisioned.', 403, 'forbidden');
  return personSchema.parse(row);
}
function assertEditor(actor: Person): void {
  if (actor.role === 'viewer') throw new WorkError('Editors or administrators are required for this operation.', 403, 'forbidden');
}
function mapAdr(row: Row): Adr {
  return adrSchema.parse({ id: row.id, itemId: row.item_id, creatorId: row.creator_id, requester: row.requester, approver: row.approver, context: row.context, concern: row.concern, decision: row.decision, alternatives: row.alternatives, consequences: row.consequences, downsides: row.downsides, rationale: row.rationale, documentUrl: row.document_url, mentionedPersonIds: row.mentioned_person_ids, status: row.status, approval: row.approval, revision: Number(row.revision), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function mapNotification(row: Row): WorkNotification {
  return workNotificationSchema.parse({ id: row.id, recipientId: row.recipient_id, actorId: row.actor_id, kind: row.kind, itemId: row.item_id, adrId: row.adr_id, updateId: row.update_id, readAt: row.read_at ? iso(row.read_at) : null, invalidatedAt: row.invalidated_at ? iso(row.invalidated_at) : null, createdAt: iso(row.created_at) });
}
async function selectAdr(client: PoolClient, id: string): Promise<Adr> {
  const row = (await client.query('SELECT * FROM simple_adrs WHERE id = $1', [id])).rows[0];
  if (!row) throw new WorkError('ADR does not exist.', 404, 'not_found');
  return mapAdr(row);
}
async function assertIdentity(client: PoolClient, identity: AdrIdentity, approver: boolean): Promise<void> {
  if (identity.kind === 'person') {
    const person = (await client.query('SELECT role FROM people WHERE id = $1', [identity.personId])).rows[0];
    if (!person) throw new WorkError('A referenced person does not exist.', 422, 'invalid_reference');
    if (approver && person.role === 'viewer') throw new WorkError('A viewer cannot be an ADR approver.', 422, 'invalid_reference');
  } else if (approver) {
    // Names are not identities. Reject all normalized exact matches, including ambiguous
    // duplicate names. This prevents obvious bypass, not aliases or impersonation.
    const match = await client.query("SELECT 1 FROM people WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(regexp_replace(btrim($1::text), '\\s+', ' ', 'g')) LIMIT 1", [identity.name]);
    if (match.rowCount) throw new WorkError('This approver name matches a provisioned person. Select their person identity instead; duplicate names require disambiguation by person ID.', 422, 'invalid_reference');
  }
}
async function assertReferences(client: PoolClient, adr: Adr): Promise<void> {
  if (!(await client.query('SELECT 1 FROM simple_items WHERE id = $1', [adr.itemId])).rowCount) throw new WorkError('ADR owner item does not exist.', 422, 'invalid_reference');
  await assertIdentity(client, adr.requester, false);
  await assertIdentity(client, adr.approver, true);
  if (adr.mentionedPersonIds.length) {
    const people = await client.query('SELECT id FROM people WHERE id = ANY($1::text[])', [adr.mentionedPersonIds]);
    if (people.rowCount !== adr.mentionedPersonIds.length) throw new WorkError('A mentioned person does not exist.', 422, 'invalid_reference');
  }
}
async function notify(client: PoolClient, adr: Adr, actor: Person, recipientId: string, kind: WorkNotification['kind']): Promise<void> {
  if (recipientId === actor.id) return;
  await client.query('INSERT INTO simple_notifications(id, recipient_id, actor_id, kind, item_id, adr_id, dedupe_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING', [randomUUID(), recipientId, actor.id, kind, adr.itemId, adr.id, `adr:${adr.id}:${adr.revision}:${kind}:${recipientId}`]);
}
const contentKeys = ['context', 'concern', 'decision', 'alternatives', 'consequences', 'downsides', 'rationale', 'documentUrl'] as const;
function sameIdentity(left: AdrIdentity, right: AdrIdentity): boolean {
  return left.kind === 'person' ? right.kind === 'person' && left.personId === right.personId : right.kind === 'name' && left.name === right.name;
}
function approvalContentChanged(previous: Adr, next: Adr): boolean {
  return contentKeys.some(key => previous[key] !== next[key]) || !sameIdentity(previous.requester, next.requester) || !sameIdentity(previous.approver, next.approver);
}
async function saveAdr(client: PoolClient, adr: Adr, create: boolean): Promise<void> {
  const values = [adr.id, adr.itemId, adr.creatorId, JSON.stringify(adr.requester), JSON.stringify(adr.approver), adr.context, adr.concern, adr.decision, adr.alternatives, adr.consequences, adr.downsides, adr.rationale, adr.documentUrl ?? null, adr.mentionedPersonIds, adr.status, adr.approval ? JSON.stringify(adr.approval) : null, adr.revision, adr.createdAt, adr.updatedAt];
  if (create) {
    await client.query('INSERT INTO simple_adrs(id,item_id,creator_id,requester,approver,context,concern,decision,alternatives,consequences,downsides,rationale,document_url,mentioned_person_ids,status,approval,revision,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)', values);
  } else {
    // The owner and creator are intentionally immutable, including at the SQL write boundary.
    const result = await client.query('UPDATE simple_adrs SET requester=$4,approver=$5,context=$6,concern=$7,decision=$8,alternatives=$9,consequences=$10,downsides=$11,rationale=$12,document_url=$13,mentioned_person_ids=$14,status=$15,approval=$16,revision=$17,updated_at=$18 WHERE id=$1 AND item_id=$2 AND creator_id=$3', [...values.slice(0, 17), adr.updatedAt]);
    if (result.rowCount !== 1) throw new WorkError('ADR does not exist.', 404, 'not_found');
  }
}
export async function executeAdr(request: AdrCommandRequest, actor: Person): Promise<AdrMutationResult> {
  const parsed = parse(adrCommandRequestSchema, request);
  return withTransaction(async client => {
    const workspace = (await client.query('SELECT revision FROM simple_workspace WHERE id = 1 FOR UPDATE')).rows[0];
    if (!workspace) throw new WorkError('Simple workspace is not initialized; run database migration.', 503, 'database_uninitialized');
    const current = await currentActor(client, actor);
    assertEditor(current);
    const revision = Number(workspace.revision);
    if (parsed.expectedRevision !== revision) throw new WorkError(`Workspace changed; expected revision ${parsed.expectedRevision}, current revision ${revision}.`, 409, 'revision_conflict');
    const command = parsed.command;
    const timestamp = new Date().toISOString();
    const previous = command.type === 'adr.create' ? null : await selectAdr(client, command.id);
    let adr: Adr;
    if (command.type === 'adr.create') {
      adr = adrSchema.parse({ ...command.adr, documentUrl: command.adr.documentUrl ?? null, requester: command.adr.requester ?? { kind: 'person', personId: current.id }, id: randomUUID(), creatorId: current.id, status: 'draft', approval: null, revision: revision + 1, createdAt: timestamp, updatedAt: timestamp });
    } else {
      adr = { ...previous!, revision: revision + 1, updatedAt: timestamp };
      if (command.type === 'adr.update') {
        adr = { ...adr, ...command.adr, documentUrl: command.adr.documentUrl ?? null };
        if (approvalContentChanged(previous!, adr)) { adr.status = 'draft'; adr.approval = null; }
      } else if (command.type === 'adr.submit') {
        if (!['draft', 'changes_requested'].includes(adr.status)) throw new WorkError('Only draft or changes-requested ADRs can be submitted.', 409, 'invalid_transition');
        adr.status = 'pending';
        adr.approval = null;
      } else {
        if (adr.status !== 'pending') throw new WorkError('An ADR must be pending before an approval response.', 409, 'invalid_transition');
        if (command.type === 'adr.record_approval') {
          if (adr.approver.kind !== 'name') throw new WorkError('Existing-user approvals must be verified by the nominated actor.', 403, 'forbidden');
          adr.status = 'approved';
          adr.approval = { mode: 'recorded', actorId: current.id, approver: adr.approver, comment: command.comment, createdAt: timestamp };
        } else {
          if (adr.approver.kind !== 'person' || adr.approver.personId !== current.id) throw new WorkError('Only the nominated approver can respond.', 403, 'forbidden');
          adr.status = command.type === 'adr.approve' ? 'approved' : 'changes_requested';
          adr.approval = command.type === 'adr.approve' ? { mode: 'verified', actorId: current.id, approver: adr.approver, comment: '', createdAt: timestamp } : null;
        }
      }
    }
    await assertReferences(client, adr);
    await saveAdr(client, adr, previous === null);
    if (previous?.status === 'pending' && (adr.status !== 'pending' || approvalContentChanged(previous, adr))) {
      await client.query("UPDATE simple_notifications SET invalidated_at = now() WHERE adr_id=$1 AND kind='approval_requested' AND invalidated_at IS NULL", [adr.id]);
    }
    if (command.type === 'adr.submit' && adr.approver.kind === 'person') await notify(client, adr, current, adr.approver.personId, 'approval_requested');
    if (['adr.approve', 'adr.request_changes', 'adr.record_approval'].includes(command.type) && adr.requester.kind === 'person') await notify(client, adr, current, adr.requester.personId, 'approval_result');
    for (const recipientId of adr.mentionedPersonIds) {
      if (!previous?.mentionedPersonIds.includes(recipientId)) await notify(client, adr, current, recipientId, 'mention');
    }
    await client.query("UPDATE simple_notifications SET invalidated_at=now() WHERE adr_id=$1 AND kind='mention' AND NOT (recipient_id = ANY($2::text[])) AND invalidated_at IS NULL", [adr.id, adr.mentionedPersonIds]);
    const historyId = randomUUID();
    await client.query('INSERT INTO simple_adr_history(id,adr_id,actor_id,action,comment,revision,snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)', [historyId, adr.id, current.id, command.type, 'comment' in command ? command.comment : null, adr.revision, JSON.stringify(adr)]);
    const historyPeople = new Set([current.id, adr.creatorId, ...adr.mentionedPersonIds]);
    for (const identity of [adr.requester, adr.approver, adr.approval?.approver]) {
      if (identity?.kind === 'person') historyPeople.add(identity.personId);
    }
    if (adr.approval) historyPeople.add(adr.approval.actorId);
    await client.query('INSERT INTO simple_adr_history_people(history_id,person_id) SELECT $1, unnest($2::text[])', [historyId, [...historyPeople]]);
    await client.query('INSERT INTO simple_changes(id,actor_id,action,entity_id) VALUES($1,$2,$3,$4)', [randomUUID(), current.id, command.type, adr.id]);
    await client.query('UPDATE simple_workspace SET revision = revision + 1, updated_at = now() WHERE id = 1');
    return { revision: adr.revision, adr };
  });
}

async function withAdrRead<T>(actor: Person, work: (client: PoolClient, revision: number) => Promise<T>): Promise<T> {
  return withTransaction(async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await currentActor(client, actor);
    const workspace = (await client.query('SELECT revision FROM simple_workspace WHERE id=1')).rows[0];
    if (!workspace) throw new WorkError('Simple workspace is not initialized; run database migration.', 503, 'database_uninitialized');
    return work(client, Number(workspace.revision));
  });
}
export async function readAdr(id: string, actor: Person): Promise<AdrMutationResult> {
  const parsed = parse(identifierSchema, id);
  return withAdrRead(actor, async (client, revision) => ({ revision, adr: await selectAdr(client, parsed) }));
}
function page<T>(items: T[], limit: number, offset: number, revision: number): AdrPage<T> {
  const hasMore = items.length > limit;
  const nextOffset = offset + limit;
  if (hasMore && !Number.isSafeInteger(nextOffset)) throw new WorkError('The next page cursor exceeds the supported integer range.', 422, 'invalid_command');
  return { revision, items: items.slice(0, limit), nextCursor: hasMore ? String(nextOffset) : null };
}
export async function listAdrs(query: AdrListQuery, actor: Person): Promise<AdrPage<Adr>> {
  const q = parse(adrListQuerySchema, query);
  return withAdrRead(actor, async (client, revision) => {
    const values: unknown[] = [];
    const filters: string[] = [];
    const bind = (value: unknown): string => { values.push(value); return `$${values.length}`; };
    if (q.status) filters.push(`a.status = ${bind(q.status)}`);
    if (q.itemId) filters.push(`a.item_id = ${bind(q.itemId)}`);
    if (q.search) filters.push(`strpos(lower(concat_ws(' ',a.context,a.concern,a.decision,a.alternatives,a.consequences,a.downsides,a.rationale,a.document_url)),lower(${bind(q.search)})) > 0`);
    const roles = q.role ? [q.role] : ['requester', 'approver'];
    if (q.personId) { const p = bind(q.personId); filters.push(`(${roles.map(role => `(a.${role}->>'kind'='person' AND a.${role}->>'personId'=${p})`).join(' OR ')})`); }
    if (q.name) { const p = bind(q.name); filters.push(`(${roles.map(role => `(strpos(lower(CASE WHEN a.${role}->>'kind'='name' THEN a.${role}->>'name' ELSE (SELECT name FROM people WHERE id=a.${role}->>'personId') END),lower(${p})) > 0)`).join(' OR ')})`); }
    const sql = `SELECT a.* FROM simple_adrs a${filters.length ? ` WHERE ${filters.join(' AND ')}` : ''} ORDER BY a.updated_at DESC,a.id LIMIT ${bind(q.limit + 1)} OFFSET ${bind(Number(q.cursor ?? 0))}`;
    const rows = await client.query(sql, values);
    return page(rows.rows.map(mapAdr), q.limit, Number(q.cursor ?? 0), revision);
  });
}
export async function readAdrHistory(query: AdrHistoryQuery, actor: Person): Promise<AdrPage<AdrHistoryEntry>> {
  const q = parse(adrHistoryQuerySchema, query);
  return withAdrRead(actor, async (client, revision) => {
    await selectAdr(client, q.adrId);
    const rows = await client.query('SELECT * FROM simple_adr_history WHERE adr_id=$1 ORDER BY revision DESC,id LIMIT $2 OFFSET $3', [q.adrId, q.limit + 1, Number(q.cursor ?? 0)]);
    return page(rows.rows.map(row => adrHistoryEntrySchema.parse({ id: row.id, adrId: row.adr_id, actorId: row.actor_id, action: row.action, comment: row.comment, revision: Number(row.revision), snapshot: row.snapshot, createdAt: iso(row.created_at) })), q.limit, Number(q.cursor ?? 0), revision);
  });
}
export async function listNotifications(query: NotificationListQuery, actor: Person): Promise<AdrPage<WorkNotification>> {
  const q = parse(notificationListQuerySchema, query);
  return withAdrRead(actor, async (client, revision) => {
    const rows = await client.query('SELECT * FROM simple_notifications WHERE recipient_id=$1 AND invalidated_at IS NULL AND (NOT $2::boolean OR read_at IS NULL) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4', [actor.id, q.unreadOnly, q.limit + 1, Number(q.cursor ?? 0)]);
    return page(rows.rows.map(mapNotification), q.limit, Number(q.cursor ?? 0), revision);
  });
}
export async function setNotificationRead(id: string, read: boolean, actor: Person): Promise<WorkNotification> {
  const parsed = parse(identifierSchema, id);
  const isRead = parse(z.boolean(), read);
  return withTransaction(async client => {
    const current = await currentActor(client, actor);
    const row = (await client.query('UPDATE simple_notifications SET read_at=CASE WHEN $3::boolean THEN coalesce(read_at,now()) ELSE NULL END WHERE id=$1 AND recipient_id=$2 AND invalidated_at IS NULL RETURNING *', [parsed, current.id, isRead])).rows[0];
    if (!row) throw new WorkError('Notification does not exist.', 404, 'not_found');
    return mapNotification(row);
  });
}
export const markNotificationRead = (id: string, actor: Person): Promise<WorkNotification> => setNotificationRead(id, true, actor);
export const createAdr = (adr: AdrCreateInput, expectedRevision: number, actor: Person): Promise<AdrMutationResult> => executeAdr({ expectedRevision, command: { type: 'adr.create', adr } }, actor);
export const updateAdr = (id: string, adr: AdrUpdateInput, expectedRevision: number, actor: Person): Promise<AdrMutationResult> => executeAdr({ expectedRevision, command: { type: 'adr.update', id, adr } }, actor);
export const submitAdrApproval = (id: string, expectedRevision: number, actor: Person): Promise<AdrMutationResult> => executeAdr({ expectedRevision, command: { type: 'adr.submit', id } }, actor);
export const approveAdr = (id: string, expectedRevision: number, actor: Person): Promise<AdrMutationResult> => executeAdr({ expectedRevision, command: { type: 'adr.approve', id } }, actor);
export const requestAdrChanges = (id: string, comment: string, expectedRevision: number, actor: Person): Promise<AdrMutationResult> => executeAdr({ expectedRevision, command: { type: 'adr.request_changes', id, comment } }, actor);
export const recordAdrApproval = (id: string, comment: string, expectedRevision: number, actor: Person): Promise<AdrMutationResult> => executeAdr({ expectedRevision, command: { type: 'adr.record_approval', id, comment } }, actor);
