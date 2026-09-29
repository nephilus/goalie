import { randomUUID, createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import {
  commandRequestSchema,
  itemInputSchema, personInputSchema, workDataSchema, workstreamInputSchema,
  outcomeInputSchema, capabilityInputSchema, signalInputSchema, opportunityInputSchema, decisionInputSchema,
  type CommandRequest, type Dependency, type Draft, type Person, type WorkData, type WorkItem, type Workstream,
  type Outcome, type Capability, type CapabilitySignal, type CoordinationOpportunity, type PortfolioDecision, type DependencyCommitment,
} from '../shared/model';
import { portfolioSourceText, opportunityIssues, evidenceIsStale, coordinationOpportunityFingerprint } from '../shared/portfolio';
import { selectPortfolioData, captureEvidence, validatePortfolioGraph, cycleWouldExist } from './portfolio-store.server';
import { pool, withTransaction } from './db.server';

// Keep the public error shape small; routes map these to JSON without exposing SQL details.
export class DomainError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 422, code = 'invalid_domain') {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.code = code;
  }
}

type Row = Record<string, any>;
const nowIso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const nullableIso = (value: unknown): string | null => value == null ? null : nowIso(value);
const hashId = (value: string): string => createHash('sha256').update(value).digest('hex');
const lowerEmail = (value: string): string => value.trim().toLowerCase();
const freshId = (): string => randomUUID();

function mapPerson(row: Row): Person {
  return { id: row.id, name: row.name, email: row.email, team: row.team, role: row.role };
}
function mapWorkstream(row: Row): Workstream {
  return { id: row.id, title: row.title, description: row.description, ownerId: row.owner_id, priority: row.priority, targetDate: row.target_date, archived: row.archived };
}
function mapItem(row: Row, assigneeIds: string[]): WorkItem {
  return { id: row.id, title: row.title, description: row.description, workstreamId: row.workstream_id, kind: row.kind, status: row.status, priority: row.priority, ownerId: row.owner_id, assigneeIds, tags: row.tags, plannedStart: row.planned_start, plannedEnd: row.planned_end, targetDate: row.target_date, blocker: row.blocker, externalUrl: row.external_url, sortOrder: row.sort_order, createdAt: nowIso(row.created_at), updatedAt: nowIso(row.updated_at), completedAt: nullableIso(row.completed_at) };
}

async function selectData(client: PoolClient): Promise<WorkData> {
  const workspace = (await client.query<Row>('SELECT revision, demo FROM workspace WHERE id = 1')).rows[0];
  if (!workspace) throw new DomainError('Workspace is not initialized; run database migration', 503, 'database_uninitialized');
  const peopleRows = await client.query<Row>('SELECT id, name, email, team, role FROM people ORDER BY lower(name), id');
  const workstreamRows = await client.query<Row>('SELECT id, title, description, owner_id, priority, target_date, archived FROM workstreams ORDER BY lower(title), id');
  const itemRows = await client.query<Row>('SELECT id, title, description, workstream_id, kind, status, priority, owner_id, tags, planned_start, planned_end, target_date, blocker, external_url, sort_order, created_at, updated_at, completed_at FROM items ORDER BY sort_order, lower(title), id');
  const assignmentRows = await client.query<Row>('SELECT item_id, person_id FROM assignments ORDER BY item_id, person_id');
  const dependencyRows = await client.query<Row>('SELECT predecessor_id, successor_id FROM dependencies ORDER BY predecessor_id, successor_id');
  const updateRows = await client.query<Row>('SELECT id, item_id, author_id, body, created_at FROM updates ORDER BY created_at, id');
  const changeRows = await client.query<Row>('SELECT id, actor_id, action, entity_id, detail_json, summary, created_at FROM audit_changes ORDER BY created_at, id');
  const assignees = new Map<string, string[]>();
  for (const row of assignmentRows.rows) assignees.set(row.item_id, [...(assignees.get(row.item_id) ?? []), row.person_id]);
  const portfolio = await selectPortfolioData(client);
  return workDataSchema.parse({
    schemaVersion: 2, revision: Number(workspace.revision), demo: Boolean(workspace.demo),
    people: peopleRows.rows.map(mapPerson), workstreams: workstreamRows.rows.map(mapWorkstream),
    items: itemRows.rows.map(row => mapItem(row, assignees.get(row.id) ?? [])),
    dependencies: dependencyRows.rows.map(row => ({ predecessorId: row.predecessor_id, successorId: row.successor_id })),
    updates: updateRows.rows.map(row => ({ id: row.id, itemId: row.item_id, authorId: row.author_id, body: row.body, createdAt: nowIso(row.created_at) })),
    changes: changeRows.rows.map(row => ({ id: row.id, actorId: row.actor_id, action: row.action, entityId: row.entity_id, summary: row.summary, detail: row.detail_json, createdAt: nowIso(row.created_at) })),
    ...portfolio,
  });
}

export async function readData(): Promise<WorkData> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const data = await selectData(client);
    assertGraph(data);
    await client.query('COMMIT');
    return data;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original */ }
    throw error;
  } finally {
    client.release();
  }
}

function assertDateOrder(item: { plannedStart: string | null; plannedEnd: string | null; targetDate?: string | null }, label: string): void {
  if (item.plannedStart && item.plannedEnd && item.plannedStart > item.plannedEnd) throw new DomainError(`${label} planned start must not be after planned end`);
}
function assertGraph(data: WorkData): void {
  const itemIds = new Set(data.items.map(item => item.id));
  const seen = new Set<string>();
  const edges = new Map<string, string[]>();
  for (const dependency of data.dependencies) {
    if (dependency.predecessorId === dependency.successorId) throw new DomainError('An item cannot depend on itself');
    if (!itemIds.has(dependency.predecessorId) || !itemIds.has(dependency.successorId)) throw new DomainError('Dependency references an unknown item');
    const key = `${dependency.predecessorId}\u0000${dependency.successorId}`;
    if (seen.has(key)) throw new DomainError('Duplicate dependency');
    seen.add(key);
    const list = edges.get(dependency.predecessorId) ?? [];
    list.push(dependency.successorId);
    edges.set(dependency.predecessorId, list);
  }
  const incoming = new Map(data.items.map(item => [item.id, 0]));
  for (const successors of edges.values()) for (const id of successors) incoming.set(id, incoming.get(id)! + 1);
  const queue = [...incoming].filter(([, count]) => count === 0).map(([id]) => id);
  for (let index = 0; index < queue.length; index++) {
    for (const id of edges.get(queue[index]) ?? []) {
      const count = incoming.get(id)! - 1;
      incoming.set(id, count);
      if (count === 0) queue.push(id);
    }
  }
  if (queue.length !== itemIds.size) throw new DomainError('Dependencies cannot contain a cycle');
  const personIds = new Set(data.people.map(person => person.id));
  const workstreamIds = new Set(data.workstreams.map(workstream => workstream.id));
  for (const workstream of data.workstreams) {
    if (workstream.ownerId && !personIds.has(workstream.ownerId)) throw new DomainError('Workstream owner references an unknown person');
  }
  for (const item of data.items) {
    if (!workstreamIds.has(item.workstreamId)) throw new DomainError('Item references an unknown workstream');
    if (item.ownerId && !personIds.has(item.ownerId)) throw new DomainError('Item owner references an unknown person');
    for (const personId of item.assigneeIds) if (!personIds.has(personId)) throw new DomainError('Assignment references an unknown person');
    if (new Set(item.assigneeIds).size !== item.assigneeIds.length) throw new DomainError('Duplicate assignment');
    assertDateOrder(item, `Item ${item.id}`);
  }
  for (const update of data.updates) {
    if (!itemIds.has(update.itemId) || !personIds.has(update.authorId)) throw new DomainError('Update references an unknown record');
  }
  validatePortfolioGraph(data);
}

function sqlError(error: unknown): never {
  const code = (error as { code?: string }).code;
  if (code === '23505') throw new DomainError('A record with that identifier already exists', 422, 'collision');
  if (code === '23503') throw new DomainError('A referenced record does not exist', 422, 'invalid_reference');
  if (code === '23514') throw new DomainError('The record violates a domain invariant', 422, 'invalid_domain');
  throw error;
}

async function insertAudit(client: PoolClient, actorId: string, action: string, entityId: string | null, summary: string, detail: Record<string, unknown> = {}): Promise<void> {
  await client.query('INSERT INTO audit_changes(id, actor_id, action, entity_id, summary, detail_json) VALUES($1, $2, $3, $4, $5, $6::jsonb)', [freshId(), actorId, action, entityId, summary, JSON.stringify(detail)]);
}

function assertWriteRole(actor: Person): void {
  if (actor.role === 'viewer') throw new DomainError('Editors or admins may modify work data', 403, 'forbidden');
}
function assertAdmin(actor: Person): void {
  if (actor.role !== 'admin') throw new DomainError('Administrators are required for this operation', 403, 'forbidden');
}

async function ensureNoCollision(client: PoolClient, table: string, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const result = await client.query<Row>(`SELECT id FROM ${table} WHERE id = ANY($1::text[])`, [ids]);
  if (result.rowCount) throw new DomainError(`Imported ${table} collide with existing records`, 422, 'collision');
}

async function applyImport(client: PoolClient, incoming: WorkData, actor: Person): Promise<{ entityId: string | null; summary: string; detail: Record<string, unknown> }> {
  for (const records of [incoming.people, incoming.workstreams, incoming.items, incoming.updates, incoming.changes, incoming.outcomes, incoming.capabilities, incoming.signals, incoming.opportunities, incoming.decisions, incoming.commitments]) {
    if (new Set(records.map(record => record.id)).size !== records.length) throw new DomainError('Import contains duplicate IDs', 422, 'collision');
  }
  for (const table of ['workstreams', 'items', 'updates', 'audit_changes', 'outcomes', 'capabilities', 'capability_signals', 'coordination_opportunities', 'portfolio_decisions', 'dependency_commitments']) {
    const records = table === 'workstreams' ? incoming.workstreams : table === 'items' ? incoming.items : table === 'updates' ? incoming.updates : table === 'audit_changes' ? incoming.changes : table === 'outcomes' ? incoming.outcomes : table === 'capabilities' ? incoming.capabilities : table === 'capability_signals' ? incoming.signals : table === 'coordination_opportunities' ? incoming.opportunities : table === 'portfolio_decisions' ? incoming.decisions : incoming.commitments;
    await ensureNoCollision(client, table, records.map(record => record.id));
  }
  const existing = await selectData(client);
  const people = new Map(existing.people.map(person => [person.id, person]));
  const existingPeople = incoming.people.filter(person => existing.people.some(candidate => candidate.id === person.id));
  for (const person of existingPeople) {
    const parsed = personInputSchema.parse({ name: person.name, email: lowerEmail(person.email), team: person.team, role: person.role });
    const duplicate = people.get(person.id)!;
    if (duplicate.name !== parsed.name || lowerEmail(duplicate.email) !== parsed.email || duplicate.team !== parsed.team || duplicate.role !== parsed.role) throw new DomainError(`Imported person ${person.id} collides with a different record`, 422, 'collision');
  }
  for (const person of incoming.people) {
    const parsed = personInputSchema.parse({ name: person.name, email: lowerEmail(person.email), team: person.team, role: person.role });
    const duplicateId = people.get(person.id);
    if (duplicateId) {
      if (duplicateId.name !== parsed.name || lowerEmail(duplicateId.email) !== parsed.email || duplicateId.team !== parsed.team || duplicateId.role !== parsed.role) throw new DomainError(`Imported person ${person.id} collides with a different record`, 422, 'collision');
      continue;
    }
    if ([...people.values()].some(value => lowerEmail(value.email) === parsed.email)) throw new DomainError(`Imported email ${parsed.email} already exists`, 422, 'collision');
    people.set(person.id, person);
    await client.query('INSERT INTO people(id, name, email, team, role) VALUES($1, $2, $3, $4, $5)', [person.id, parsed.name, parsed.email, parsed.team, parsed.role]);
  }
  const workstreamIds = new Set([...existing.workstreams.map(item => item.id), ...incoming.workstreams.map(item => item.id)]);
  for (const workstream of incoming.workstreams) {
    const parsed = workstreamInputSchema.parse({ title: workstream.title, description: workstream.description, ownerId: workstream.ownerId, priority: workstream.priority, targetDate: workstream.targetDate, archived: workstream.archived });
    if (parsed.ownerId && !people.has(parsed.ownerId)) throw new DomainError('Imported workstream owner does not exist');
    await client.query('INSERT INTO workstreams(id, title, description, owner_id, priority, target_date, archived) VALUES($1, $2, $3, $4, $5, $6, $7)', [workstream.id, parsed.title, parsed.description, parsed.ownerId, parsed.priority, parsed.targetDate, parsed.archived]);
  }
  const items = new Map(existing.items.map(item => [item.id, item]));
  const itemIds = new Set([...existing.items.map(item => item.id), ...incoming.items.map(item => item.id)]);
  for (const item of incoming.items) {
    const parsed = itemInputSchema.parse({ title: item.title, description: item.description, workstreamId: item.workstreamId, kind: item.kind, status: item.status, priority: item.priority, ownerId: item.ownerId, assigneeIds: item.assigneeIds, tags: item.tags, plannedStart: item.plannedStart, plannedEnd: item.plannedEnd, targetDate: item.targetDate, blocker: item.blocker, externalUrl: item.externalUrl, sortOrder: item.sortOrder });
    if (!workstreamIds.has(parsed.workstreamId) || (parsed.ownerId && !people.has(parsed.ownerId)) || parsed.assigneeIds.some(id => !people.has(id))) throw new DomainError('Imported item references a missing record');
    assertDateOrder(parsed, `Item ${item.id}`);
    await client.query('INSERT INTO items(id, title, description, workstream_id, kind, status, priority, owner_id, tags, planned_start, planned_end, target_date, blocker, external_url, sort_order, created_at, updated_at, completed_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)', [item.id, parsed.title, parsed.description, parsed.workstreamId, parsed.kind, parsed.status, parsed.priority, parsed.ownerId, parsed.tags, parsed.plannedStart, parsed.plannedEnd, parsed.targetDate, parsed.blocker, parsed.externalUrl, parsed.sortOrder, item.createdAt, item.updatedAt, item.completedAt]);
    for (const personId of parsed.assigneeIds) await client.query('INSERT INTO assignments(item_id, person_id) VALUES($1, $2)', [item.id, personId]);
    items.set(item.id, { ...item, tags: parsed.tags });
  }
  const dataAfterItems: WorkData = { ...existing, people: [...people.values()], workstreams: [...existing.workstreams, ...incoming.workstreams], items: [...items.values()], dependencies: [...existing.dependencies], updates: [...existing.updates], changes: [...existing.changes] };
  for (const dependency of incoming.dependencies) {
    if (!itemIds.has(dependency.predecessorId) || !itemIds.has(dependency.successorId)) throw new DomainError('Imported dependency references a missing item');
    await client.query('INSERT INTO dependencies(predecessor_id, successor_id) VALUES($1, $2)', [dependency.predecessorId, dependency.successorId]);
    dataAfterItems.dependencies.push(dependency);
  }
  for (const update of incoming.updates) {
    if (!itemIds.has(update.itemId) || !people.has(update.authorId)) throw new DomainError('Imported update references a missing record');
    await client.query('INSERT INTO updates(id, item_id, author_id, body, created_at) VALUES($1, $2, $3, $4, $5)', [update.id, update.itemId, update.authorId, update.body, update.createdAt]);
    dataAfterItems.updates.push(update);
  }

  for (const change of incoming.changes) {
    if (!people.has(change.actorId)) throw new DomainError('Imported audit change references a missing person');
    await client.query('INSERT INTO audit_changes(id, actor_id, action, entity_id, summary, detail_json, created_at) VALUES($1, $2, $3, $4, $5, $6::jsonb, $7)', [change.id, change.actorId, change.action, change.entityId, change.summary, JSON.stringify({ ...change.detail, importedBy: actor.id, importedAt: new Date().toISOString() }), change.createdAt]);
  }
  await applyPortfolioImport(client, incoming, dataAfterItems);
  await client.query('UPDATE workspace SET demo = demo OR $1, updated_at = now() WHERE id = 1', [incoming.demo]);
  return { entityId: null, summary: `Imported ${incoming.people.length} people, ${incoming.workstreams.length} workstreams and ${incoming.items.length} items`, detail: { people: incoming.people.length, workstreams: incoming.workstreams.length, items: incoming.items.length, dependencies: incoming.dependencies.length, updates: incoming.updates.length } };
}
async function applyPortfolioImport(client: PoolClient, incoming: WorkData, base: WorkData): Promise<void> {
  const data: WorkData = { ...base, workstreams: [...base.workstreams], items: [...base.items], outcomes: [...base.outcomes], capabilities: [...base.capabilities], signals: [...base.signals], opportunities: [...base.opportunities], decisions: [...base.decisions], commitments: [...base.commitments], dependencies: [...base.dependencies] };
  const importedEdges = new Set(incoming.dependencies.map(edge => `${edge.predecessorId}\u0000${edge.successorId}`));
  const people = new Set(data.people.map(person => person.id));
  const workstreams = new Set(data.workstreams.map(stream => stream.id));
  const items = new Set(data.items.map(item => item.id));
  for (const row of incoming.outcomes) {
    const parsed = outcomeInputSchema.parse({ workstreamId: row.workstreamId, title: row.title, description: row.description, ownerId: row.ownerId, priority: row.priority, status: row.status, window: row.window, itemIds: row.itemIds });
    if (!workstreams.has(parsed.workstreamId) || (parsed.ownerId && !people.has(parsed.ownerId)) || parsed.itemIds.some(id => !items.has(id))) throw new DomainError('Imported outcome references a missing record');
    await client.query('INSERT INTO outcomes(id, workstream_id, title, description, owner_id, priority, status, window_json, item_ids_json, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11)', [row.id, parsed.workstreamId, parsed.title, parsed.description, parsed.ownerId, parsed.priority, parsed.status, JSON.stringify(parsed.window), JSON.stringify(parsed.itemIds), row.createdAt, row.updatedAt]);
    data.outcomes.push(row);
  }
  for (const row of incoming.capabilities) {
    const parsed = capabilityInputSchema.parse({ name: row.name, description: row.description });
    await client.query('INSERT INTO capabilities(id, name, description, created_at, updated_at) VALUES($1,$2,$3,$4,$5)', [row.id, parsed.name, parsed.description, row.createdAt, row.updatedAt]);
    data.capabilities.push(row);
  }
  const outcomeIds = new Set(data.outcomes.map(row => row.id));
  const capabilityIds = new Set(data.capabilities.map(row => row.id));
  for (const row of incoming.signals) {
    const parsed = signalInputSchema.parse({ outcomeId: row.outcomeId, capabilityId: row.capabilityId, direction: row.direction, scope: row.scope, window: row.window, note: row.note });
    if (!outcomeIds.has(parsed.outcomeId) || !capabilityIds.has(parsed.capabilityId)) throw new DomainError('Imported signal references a missing record');
    await client.query('INSERT INTO capability_signals(id, outcome_id, capability_id, direction, scope, window_json, note, created_at, updated_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)', [row.id, parsed.outcomeId, parsed.capabilityId, parsed.direction, parsed.scope, JSON.stringify(parsed.window), parsed.note, row.createdAt, row.updatedAt]);
    data.signals.push(row);
  }
  for (const row of incoming.opportunities) {
    const parsed = opportunityInputSchema.parse({ title: row.title, kind: row.kind, description: row.description, outcomeIds: row.outcomeIds, capabilityIds: row.capabilityIds, window: row.window, decisionBy: row.decisionBy, evidence: row.evidence.map(({ sourceType, sourceId, quote }) => ({ sourceType, sourceId, quote })), options: row.options, questions: row.questions });
    validateImportedEvidence(data, row.evidence);
    await client.query('INSERT INTO coordination_opportunities(id,title,kind,description,outcome_ids_json,capability_ids_json,window_json,decision_by,evidence_json,options_json,questions_json,origin,status,dismissal_reason,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16)', [row.id, parsed.title, parsed.kind, parsed.description, JSON.stringify(parsed.outcomeIds), JSON.stringify(parsed.capabilityIds), JSON.stringify(parsed.window), parsed.decisionBy, JSON.stringify(row.evidence), JSON.stringify(parsed.options), JSON.stringify(parsed.questions), row.origin, row.status, row.dismissalReason, row.createdAt, row.updatedAt]);
    data.opportunities.push(row);
  }
  const opportunityIds = new Set(data.opportunities.map(row => row.id));
  for (const row of incoming.decisions) {
    if (!opportunityIds.has(row.opportunityId) || !people.has(row.ownerId) || !people.has(row.decidedBy)) throw new DomainError('Imported decision references a missing record');
    validateImportedEvidence(data, row.evidence);
    await client.query('INSERT INTO portfolio_decisions(id,opportunity_id,owner_id,rationale,review_date,review_milestone_id,review_note,transition_window_json,option_json,opportunity_title,evidence_json,outcome_ids_json,status,decided_by,decided_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$14,$15)', [row.id, row.opportunityId, row.ownerId, row.rationale, row.reviewDate, row.reviewMilestoneId, row.reviewNote, JSON.stringify(row.transitionWindow), JSON.stringify(row.option), row.opportunityTitle, JSON.stringify(row.evidence), JSON.stringify(row.outcomeIds), row.status, row.decidedBy, row.decidedAt]);
    data.decisions.push(row);
  }
  const decisionIds = new Set(data.decisions.map(row => row.id));
  for (const row of incoming.commitments) {
    if (!decisionIds.has(row.decisionId) || !items.has(row.predecessorId) || !items.has(row.successorId)) throw new DomainError('Imported commitment references a missing record');
    const decision = data.decisions.find(candidate => candidate.id === row.decisionId)!;
    if (row.status !== 'withdrawn' && decision.status !== 'active') throw new DomainError('Only active decisions may own live commitments');
    if (row.status === 'active' && !importedEdges.has(`${row.predecessorId}\u0000${row.successorId}`)) throw new DomainError('Imported active commitment must include its dependency edge');
    await client.query('INSERT INTO dependency_commitments(id,decision_id,predecessor_id,successor_id,activation,activate_on,milestone_id,status,created_at,activated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', [row.id, row.decisionId, row.predecessorId, row.successorId, row.activation, row.activateOn, row.milestoneId, row.status, row.createdAt, row.activatedAt]);
    data.commitments.push(row);
  }
}

async function applyDraft(client: PoolClient, draft: Draft, current: WorkData): Promise<{ entityId: string | null; summary: string; detail: Record<string, unknown> }> {
  if (!draft.items.length) throw new DomainError('Draft has no items to apply');
  const workstreamId = draft.items[0].workstreamId;
  if (draft.items.some(item => item.workstreamId !== workstreamId)) throw new DomainError('A reviewed draft may target only one workstream');
  if (!current.workstreams.some(item => item.id === workstreamId)) throw new DomainError('Draft workstream does not exist');
  const refs = new Map<string, string>();
  for (const item of draft.items) {
    if (refs.has(item.ref)) throw new DomainError('Draft references must be unique');
    if (current.items.some(existing => existing.id === item.ref)) throw new DomainError('Draft reference collides with an existing item');
    refs.set(item.ref, freshId());
  }
  const newItems: WorkItem[] = [];
  for (const draftItem of draft.items) {
    const id = refs.get(draftItem.ref)!;
    const parsed = itemInputSchema.parse({ title: draftItem.title, description: draftItem.description, workstreamId, kind: draftItem.kind, status: draftItem.status, priority: draftItem.priority, ownerId: draftItem.ownerId, assigneeIds: draftItem.assigneeIds, plannedStart: draftItem.plannedStart, plannedEnd: draftItem.plannedEnd, targetDate: draftItem.targetDate, blocker: draftItem.blocker, externalUrl: draftItem.externalUrl, sortOrder: draftItem.sortOrder });
    if ((parsed.ownerId && !current.people.some(person => person.id === parsed.ownerId)) || parsed.assigneeIds.some(personId => !current.people.some(person => person.id === personId))) throw new DomainError('Draft assignment references an unknown person');
    assertDateOrder(parsed, `Draft item ${draftItem.ref}`);
    await client.query('INSERT INTO items(id, title, description, workstream_id, kind, status, priority, owner_id, tags, planned_start, planned_end, target_date, blocker, external_url, sort_order, completed_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CASE WHEN $6 = \'done\' THEN now() ELSE NULL END)', [id, parsed.title, parsed.description, workstreamId, parsed.kind, parsed.status, parsed.priority, parsed.ownerId, parsed.tags, parsed.plannedStart, parsed.plannedEnd, parsed.targetDate, parsed.blocker, parsed.externalUrl, parsed.sortOrder]);
    for (const personId of parsed.assigneeIds) await client.query('INSERT INTO assignments(item_id, person_id) VALUES($1, $2)', [id, personId]);
    newItems.push({ ...parsed, id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: parsed.status === 'done' ? new Date().toISOString() : null });
  }
  const allData = { ...current, items: [...current.items, ...newItems], dependencies: [...current.dependencies] };
  for (const dependency of draft.dependencies) {
    const predecessorId = refs.get(dependency.predecessorId) ?? dependency.predecessorId;
    const successorId = refs.get(dependency.successorId) ?? dependency.successorId;
    if (!allData.items.some(item => item.id === predecessorId) || !allData.items.some(item => item.id === successorId)) throw new DomainError('Draft dependency references must use a draft ref or existing item id');
    const edge = { predecessorId, successorId };
    allData.dependencies.push(edge);
    await client.query('INSERT INTO dependencies(predecessor_id, successor_id) VALUES($1, $2)', [predecessorId, successorId]);
  }
  return { entityId: workstreamId, summary: `Applied ${newItems.length} reviewed draft item${newItems.length === 1 ? '' : 's'}`, detail: { itemIds: newItems.map(item => item.id), questions: draft.questions, evidence: draft.items.map(item => ({ ref: item.ref, evidence: item.evidence, inferredFields: item.inferredFields })) } };
}
function evidenceFor(data: WorkData, inputs: { sourceType: 'item' | 'update' | 'workstream' | 'outcome' | 'capability' | 'signal'; sourceId: string; quote: string }[], outcomeIds: string[] = []) {
  try { return captureEvidence(data, inputs, outcomeIds); } catch (error) { throw new DomainError(error instanceof Error ? error.message : 'Invalid evidence'); }
}

function validateImportedEvidence(data: WorkData, evidence: { sourceType: 'item' | 'update' | 'workstream' | 'outcome' | 'capability' | 'signal'; sourceId: string; quote: string; sourceText: string }[]): void {
  for (const item of evidence) {
    if (!item.sourceText.includes(item.quote)) throw new DomainError(`Imported evidence for ${item.sourceType}:${item.sourceId} is invalid`);
  }
}

async function applyPortfolioCommand(client: PoolClient, current: WorkData, command: Exclude<CommandRequest['command'], { type: 'data.import' | 'draft.apply' | 'person.create' | 'person.update' | 'workstream.create' | 'workstream.update' | 'item.create' | 'item.update' | 'dependency.add' | 'dependency.remove' | 'update.add' }>, actor: Person): Promise<{ entityId: string | null; summary: string; detail: Record<string, unknown> }> {
  if (command.type === 'outcome.create' || command.type === 'outcome.update') {
    const parsed = outcomeInputSchema.parse(command.outcome);
    if (!current.workstreams.some(row => row.id === parsed.workstreamId)) throw new DomainError('Outcome workstream does not exist');
    if (parsed.ownerId && !current.people.some(row => row.id === parsed.ownerId)) throw new DomainError('Outcome owner does not exist');
    if (parsed.itemIds.some(id => !current.items.some(row => row.id === id))) throw new DomainError('Outcome references an unknown item');
    const id = command.type === 'outcome.create' ? freshId() : command.id;
    if (command.type === 'outcome.update' && !current.outcomes.some(row => row.id === id)) throw new DomainError('Outcome does not exist', 422, 'not_found');
    await client.query(command.type === 'outcome.create' ? 'INSERT INTO outcomes(id,workstream_id,title,description,owner_id,priority,status,window_json,item_ids_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)' : 'UPDATE outcomes SET workstream_id=$2,title=$3,description=$4,owner_id=$5,priority=$6,status=$7,window_json=$8::jsonb,item_ids_json=$9::jsonb,updated_at=now() WHERE id=$1', [id, parsed.workstreamId, parsed.title, parsed.description, parsed.ownerId, parsed.priority, parsed.status, JSON.stringify(parsed.window), JSON.stringify(parsed.itemIds)]);
    return { entityId: id, summary: `${command.type === 'outcome.create' ? 'Created' : 'Updated'} outcome ${parsed.title}`, detail: { title: parsed.title } };
  }
  if (command.type === 'capability.create' || command.type === 'capability.update') {
    const parsed = capabilityInputSchema.parse(command.capability);
    const id = command.type === 'capability.create' ? freshId() : command.id;
    if (command.type === 'capability.update' && !current.capabilities.some(row => row.id === id)) throw new DomainError('Capability does not exist', 422, 'not_found');
    await client.query(command.type === 'capability.create' ? 'INSERT INTO capabilities(id,name,description) VALUES($1,$2,$3)' : 'UPDATE capabilities SET name=$2,description=$3,updated_at=now() WHERE id=$1', [id, parsed.name, parsed.description]);
    return { entityId: id, summary: `${command.type === 'capability.create' ? 'Created' : 'Updated'} capability ${parsed.name}`, detail: {} };
  }
  if (command.type === 'signal.create' || command.type === 'signal.update') {
    const parsed = signalInputSchema.parse(command.signal);
    if (!current.outcomes.some(row => row.id === parsed.outcomeId) || !current.capabilities.some(row => row.id === parsed.capabilityId)) throw new DomainError('Signal references an unknown record');
    const id = command.type === 'signal.create' ? freshId() : command.id;
    if (command.type === 'signal.update' && !current.signals.some(row => row.id === id)) throw new DomainError('Signal does not exist', 422, 'not_found');
    await client.query(command.type === 'signal.create' ? 'INSERT INTO capability_signals(id,outcome_id,capability_id,direction,scope,window_json,note) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)' : 'UPDATE capability_signals SET outcome_id=$2,capability_id=$3,direction=$4,scope=$5,window_json=$6::jsonb,note=$7,updated_at=now() WHERE id=$1', [id, parsed.outcomeId, parsed.capabilityId, parsed.direction, parsed.scope, JSON.stringify(parsed.window), parsed.note]);
    return { entityId: id, summary: `${command.type === 'signal.create' ? 'Created' : 'Updated'} capability signal`, detail: {} };
  }
  if (command.type === 'signal.remove') {
    if (!current.signals.some(row => row.id === command.id)) throw new DomainError('Signal does not exist', 422, 'not_found');
    await client.query('DELETE FROM capability_signals WHERE id=$1', [command.id]);
    return { entityId: command.id, summary: 'Removed capability signal', detail: {} };
  }
  if (command.type === 'opportunity.create' || command.type === 'opportunity.update') {
    const parsed = opportunityInputSchema.parse(command.opportunity);
    const issues = opportunityIssues(current, parsed);
    if (issues.length) throw new DomainError(issues.join(' '));
    const evidence = evidenceFor(current, parsed.evidence, parsed.outcomeIds);
    const id = command.type === 'opportunity.create' ? freshId() : command.id;
    if (command.type === 'opportunity.update' && !current.opportunities.some(row => row.id === id)) throw new DomainError('Opportunity does not exist', 422, 'not_found');
    const previous = current.opportunities.find(row => row.id === id);
    const origin = previous?.origin ?? 'manual';
    const status = previous?.status === 'decided' ? 'decided' : 'open';
    await client.query(command.type === 'opportunity.create' ? 'INSERT INTO coordination_opportunities(id,title,kind,description,outcome_ids_json,capability_ids_json,window_json,decision_by,evidence_json,options_json,questions_json,origin,status,dismissal_reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14)' : 'UPDATE coordination_opportunities SET title=$2,kind=$3,description=$4,outcome_ids_json=$5::jsonb,capability_ids_json=$6::jsonb,window_json=$7::jsonb,decision_by=$8,evidence_json=$9::jsonb,options_json=$10::jsonb,questions_json=$11::jsonb,origin=$12,status=$13,dismissal_reason=$14,updated_at=now() WHERE id=$1', [id, parsed.title, parsed.kind, parsed.description, JSON.stringify(parsed.outcomeIds), JSON.stringify(parsed.capabilityIds), JSON.stringify(parsed.window), parsed.decisionBy, JSON.stringify(evidence), JSON.stringify(parsed.options), JSON.stringify(parsed.questions), origin, status, '']);
    return { entityId: id, summary: `${command.type === 'opportunity.create' ? 'Created' : 'Updated'} coordination opportunity`, detail: { evidenceCount: evidence.length } };
  }
  if (command.type === 'opportunity.dismiss') {
    const opportunity = current.opportunities.find(row => row.id === command.id);
    if (!opportunity) throw new DomainError('Opportunity does not exist', 422, 'not_found');
    if (opportunity.status === 'decided') throw new DomainError('A decided opportunity cannot be dismissed');
    await client.query('UPDATE coordination_opportunities SET status=$2,dismissal_reason=$3,updated_at=now() WHERE id=$1', [command.id, 'dismissed', command.reason]);
    return { entityId: command.id, summary: 'Dismissed coordination opportunity', detail: { reason: command.reason } };
  }
  if (command.type === 'coordination.apply') {
    for (const proposed of command.draft.opportunities) {
      const issues = opportunityIssues(current, proposed);
      if (issues.length) throw new DomainError(issues.join(' '));
      const fingerprint = coordinationOpportunityFingerprint(proposed);
      const duplicate = current.opportunities.some(row => (row.status === 'dismissed' || row.status === 'decided') && coordinationOpportunityFingerprint(row) === fingerprint && !row.evidence.some(evidence => evidenceIsStale(current, evidence)));
      if (duplicate) throw new DomainError('An identical coordination suggestion was already dismissed or decided');
    }
    for (const proposed of command.draft.opportunities) {
      const evidence = evidenceFor(current, proposed.evidence, proposed.outcomeIds);
      await client.query('INSERT INTO coordination_opportunities(id,title,kind,description,outcome_ids_json,capability_ids_json,window_json,decision_by,evidence_json,options_json,questions_json,origin,status,dismissal_reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14)', [freshId(), proposed.title, proposed.kind, proposed.description, JSON.stringify(proposed.outcomeIds), JSON.stringify(proposed.capabilityIds), JSON.stringify(proposed.window), proposed.decisionBy, JSON.stringify(evidence), JSON.stringify(proposed.options), JSON.stringify(proposed.questions), 'ai', 'open', '']);
    }
    return { entityId: null, summary: `Applied ${command.draft.opportunities.length} coordination opportunities`, detail: { questions: command.draft.questions } };
  }
  if (command.type === 'decision.record') {
    const input = decisionInputSchema.parse(command.decision);
    const opportunity = current.opportunities.find(row => row.id === input.opportunityId);
    if (!opportunity || opportunity.status === 'dismissed') throw new DomainError('Only an open or previously decided opportunity can receive a decision');
    if (opportunity.evidence.some(evidence => portfolioSourceText(current, evidence) !== evidence.sourceText)) throw new DomainError('Opportunity evidence changed; review before recording a decision');
    if (!current.people.some(row => row.id === input.ownerId)) throw new DomainError('Decision owner does not exist');
    const option = opportunity.options.find(candidate => candidate.id === input.optionId);
    if (!option) throw new DomainError('The selected planning option does not exist');
    if ((option.strategy === 'revisit' || option.strategy === 'temporary_bridge') && !input.reviewDate && !input.reviewMilestoneId) throw new DomainError('This option requires a concrete review date or milestone');
    if (input.reviewMilestoneId && current.items.find(row => row.id === input.reviewMilestoneId)?.kind !== 'milestone') throw new DomainError('Review trigger must refer to a milestone');
    for (const edge of option.dependencies) {
      if (!current.items.some(item => item.id === edge.predecessorId) || !current.items.some(item => item.id === edge.successorId)) throw new DomainError('Decision dependency references an unknown item');
      if (edge.activation === 'after_milestone' && current.items.find(item => item.id === edge.milestoneId)?.kind !== 'milestone') throw new DomainError('Commitment activation must refer to a milestone');
    }
    const evidence = evidenceFor(current, opportunity.evidence.map(({ sourceType, sourceId, quote }) => ({ sourceType, sourceId, quote })), opportunity.outcomeIds);
    const existing = current.decisions.filter(row => row.opportunityId === opportunity.id && row.status === 'active');
    for (const prior of existing) if (current.commitments.some(row => row.decisionId === prior.id && row.status !== 'withdrawn')) throw new DomainError('Withdraw earlier decision commitments before replacing it');
    const id = freshId();
    await client.query('UPDATE portfolio_decisions SET status=$2 WHERE opportunity_id=$1 AND status = \'active\'', [opportunity.id, 'superseded']);
    await client.query('INSERT INTO portfolio_decisions(id,opportunity_id,owner_id,rationale,review_date,review_milestone_id,review_note,transition_window_json,option_json,opportunity_title,evidence_json,outcome_ids_json,status,decided_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$14)', [id, opportunity.id, input.ownerId, input.rationale, input.reviewDate, input.reviewMilestoneId, input.reviewNote, JSON.stringify(input.transitionWindow), JSON.stringify(option), opportunity.title, JSON.stringify(evidence), JSON.stringify(opportunity.outcomeIds), 'active', actor.id]);
    await client.query('UPDATE coordination_opportunities SET status=$2,updated_at=now() WHERE id=$1', [opportunity.id, 'decided']);
    for (const edge of option.dependencies) {
      const commitmentId = freshId();
      const status = edge.activation === 'now' ? 'active' : 'planned';
      if (status === 'active') {
        if (current.dependencies.some(dep => dep.predecessorId === edge.predecessorId && dep.successorId === edge.successorId) || cycleWouldExist(current.dependencies, edge)) throw new DomainError('Decision dependency conflicts with the current execution graph');
        await client.query('INSERT INTO dependencies(predecessor_id,successor_id) VALUES($1,$2)', [edge.predecessorId, edge.successorId]);
        current.dependencies.push({ predecessorId: edge.predecessorId, successorId: edge.successorId });
      }
      await client.query('INSERT INTO dependency_commitments(id,decision_id,predecessor_id,successor_id,activation,activate_on,milestone_id,status,activated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,CASE WHEN $8 = \'active\' THEN now() ELSE NULL END)', [commitmentId, id, edge.predecessorId, edge.successorId, edge.activation, edge.activateOn, edge.milestoneId, status]);
    }
    return { entityId: id, summary: `Recorded decision for ${opportunity.title}`, detail: { optionId: option.id } };
  }
  if (command.type === 'commitment.activate' || command.type === 'commitment.withdraw') {
    const commitment = current.commitments.find(row => row.id === command.id);
    if (!commitment) throw new DomainError('Commitment does not exist', 422, 'not_found');
    if (command.type === 'commitment.withdraw') {
      if (commitment.status === 'withdrawn') throw new DomainError('Commitment is already withdrawn');
      await client.query('UPDATE dependency_commitments SET status=$2 WHERE id=$1', [command.id, 'withdrawn']);
      if (commitment.status === 'active') await client.query('DELETE FROM dependencies WHERE predecessor_id=$1 AND successor_id=$2', [commitment.predecessorId, commitment.successorId]);
      return { entityId: command.id, summary: 'Withdrew dependency commitment', detail: {} };
    }
    if (commitment.status !== 'planned') throw new DomainError('Only planned commitments can activate');
    if (commitment.activation === 'after_date' && (!commitment.activateOn || commitment.activateOn > new Date().toISOString().slice(0, 10))) throw new DomainError('Commitment activation date has not been reached');
    if (commitment.activation === 'after_milestone' && current.items.find(row => row.id === commitment.milestoneId)?.status !== 'done') throw new DomainError('Commitment milestone has not been completed');
    if (current.dependencies.some(edge => edge.predecessorId === commitment.predecessorId && edge.successorId === commitment.successorId) || cycleWouldExist(current.dependencies, commitment)) throw new DomainError('Commitment conflicts with the current execution graph');
    await client.query('INSERT INTO dependencies(predecessor_id,successor_id) VALUES($1,$2)', [commitment.predecessorId, commitment.successorId]);
    await client.query('UPDATE dependency_commitments SET status=$2,activated_at=now() WHERE id=$1', [command.id, 'active']);
    return { entityId: command.id, summary: 'Activated dependency commitment', detail: {} };
  }
  throw new DomainError('Unsupported portfolio command');
}

async function applyCommand(client: PoolClient, current: WorkData, request: CommandRequest, actor: Person): Promise<{ entityId: string | null; summary: string; detail: Record<string, unknown> }> {
  const command = request.command;
  if (command.type === 'data.import') {
    assertAdmin(actor);
    return applyImport(client, command.data, actor);
  }
  if (command.type === 'draft.apply') {
    assertWriteRole(actor);
    return applyDraft(client, command.draft, current);
  }
  assertWriteRole(actor);
  if (command.type === 'person.create') {
    assertAdmin(actor);
    const parsed = personInputSchema.parse(command.person);
    const id = freshId();
    const email = lowerEmail(parsed.email);
    await client.query('INSERT INTO people(id, name, email, team, role) VALUES($1, $2, $3, $4, $5)', [id, parsed.name, email, parsed.team, parsed.role]);
    return { entityId: id, summary: `Added person ${parsed.name}`, detail: { email, role: parsed.role } };
  }
  if (command.type === 'person.update') {
    const parsed = personInputSchema.parse(command.person);
    const existing = current.people.find(person => person.id === command.id);
    if (!existing) throw new DomainError('Person does not exist', 422, 'not_found');
    if (existing.role === 'admin' && parsed.role !== 'admin' && current.people.filter(person => person.role === 'admin').length <= 1) throw new DomainError('The last administrator cannot be removed');
    const email = lowerEmail(parsed.email);
    await client.query('UPDATE people SET name = $1, email = $2, team = $3, role = $4 WHERE id = $5', [parsed.name, email, parsed.team, parsed.role, command.id]);
    return { entityId: command.id, summary: `Updated person ${parsed.name}`, detail: { fields: ['name', 'email', 'team', 'role'] } };
  }
  if (command.type === 'workstream.create') {
    const parsed = workstreamInputSchema.parse(command.workstream);
    if (parsed.ownerId && !current.people.some(person => person.id === parsed.ownerId)) throw new DomainError('Workstream owner does not exist');
    const id = freshId();
    await client.query('INSERT INTO workstreams(id, title, description, owner_id, priority, target_date, archived) VALUES($1, $2, $3, $4, $5, $6, $7)', [id, parsed.title, parsed.description, parsed.ownerId, parsed.priority, parsed.targetDate, parsed.archived]);
    return { entityId: id, summary: `Created workstream ${parsed.title}`, detail: { title: parsed.title } };
  }
  if (command.type === 'workstream.update') {
    const parsed = workstreamInputSchema.parse(command.workstream);
    if (!current.workstreams.some(item => item.id === command.id)) throw new DomainError('Workstream does not exist', 422, 'not_found');
    if (parsed.ownerId && !current.people.some(person => person.id === parsed.ownerId)) throw new DomainError('Workstream owner does not exist');
    await client.query('UPDATE workstreams SET title = $1, description = $2, owner_id = $3, priority = $4, target_date = $5, archived = $6, updated_at = now() WHERE id = $7', [parsed.title, parsed.description, parsed.ownerId, parsed.priority, parsed.targetDate, parsed.archived, command.id]);
    return { entityId: command.id, summary: `Updated workstream ${parsed.title}`, detail: { fields: ['title', 'description', 'ownerId', 'priority', 'targetDate', 'archived'] } };
  }
  if (command.type === 'item.create') {
    const parsed = itemInputSchema.parse(command.item);
    if (!current.workstreams.some(item => item.id === parsed.workstreamId)) throw new DomainError('Item workstream does not exist');
    if (parsed.ownerId && !current.people.some(person => person.id === parsed.ownerId)) throw new DomainError('Item owner does not exist');
    if (parsed.assigneeIds.some(id => !current.people.some(person => person.id === id))) throw new DomainError('Assignment references an unknown person');
    assertDateOrder(parsed, 'Item');
    const id = freshId();
    await client.query('INSERT INTO items(id, title, description, workstream_id, kind, status, priority, owner_id, tags, planned_start, planned_end, target_date, blocker, external_url, sort_order, completed_at) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, CASE WHEN $6 = \'done\' THEN now() ELSE NULL END)', [id, parsed.title, parsed.description, parsed.workstreamId, parsed.kind, parsed.status, parsed.priority, parsed.ownerId, parsed.tags, parsed.plannedStart, parsed.plannedEnd, parsed.targetDate, parsed.blocker, parsed.externalUrl, parsed.sortOrder]);
    for (const personId of parsed.assigneeIds) await client.query('INSERT INTO assignments(item_id, person_id) VALUES($1, $2)', [id, personId]);
    return { entityId: id, summary: `Created item ${parsed.title}`, detail: { title: parsed.title, assigneeIds: parsed.assigneeIds } };
  }
  if (command.type === 'item.update') {
    const parsed = itemInputSchema.parse(command.item);
    if (!current.items.some(item => item.id === command.id)) throw new DomainError('Item does not exist', 422, 'not_found');
    if (!current.workstreams.some(item => item.id === parsed.workstreamId)) throw new DomainError('Item workstream does not exist');
    if (parsed.ownerId && !current.people.some(person => person.id === parsed.ownerId)) throw new DomainError('Item owner does not exist');
    if (parsed.assigneeIds.some(id => !current.people.some(person => person.id === id))) throw new DomainError('Assignment references an unknown person');
    assertDateOrder(parsed, 'Item');
    await client.query('UPDATE items SET title = $1, description = $2, workstream_id = $3, kind = $4, status = $5, priority = $6, owner_id = $7, tags = $8, planned_start = $9, planned_end = $10, target_date = $11, blocker = $12, external_url = $13, sort_order = $14, updated_at = now(), completed_at = CASE WHEN $5 = \'done\' THEN COALESCE(completed_at, now()) ELSE NULL END WHERE id = $15', [parsed.title, parsed.description, parsed.workstreamId, parsed.kind, parsed.status, parsed.priority, parsed.ownerId, parsed.tags, parsed.plannedStart, parsed.plannedEnd, parsed.targetDate, parsed.blocker, parsed.externalUrl, parsed.sortOrder, command.id]);
    await client.query('DELETE FROM assignments WHERE item_id = $1', [command.id]);
    for (const personId of parsed.assigneeIds) await client.query('INSERT INTO assignments(item_id, person_id) VALUES($1, $2)', [command.id, personId]);
    const before = current.items.find(item => item.id === command.id)!;
    const fields = Object.keys(parsed).filter(key => JSON.stringify(before[key as keyof WorkItem]) !== JSON.stringify(parsed[key as keyof typeof parsed]));
    const statusChange = before.status === parsed.status ? '' : ` (${before.status} → ${parsed.status})`;
    return { entityId: command.id, summary: `Updated ${parsed.title}${statusChange}: ${fields.join(', ') || 'no field changes'}`, detail: { before, after: parsed } };
  }
  if (['outcome.create', 'outcome.update', 'capability.create', 'capability.update', 'signal.create', 'signal.update', 'signal.remove', 'opportunity.create', 'opportunity.update', 'opportunity.dismiss', 'coordination.apply', 'decision.record', 'commitment.activate', 'commitment.withdraw'].includes(command.type)) return applyPortfolioCommand(client, current, command as never, actor);
  if (command.type === 'dependency.add' || command.type === 'dependency.remove') {
    const dependency: Dependency = command.dependency;
    if (dependency.predecessorId === dependency.successorId) throw new DomainError('An item cannot depend on itself');
    if (!current.items.some(item => item.id === dependency.predecessorId) || !current.items.some(item => item.id === dependency.successorId)) throw new DomainError('Dependency references an unknown item');
    if (command.type === 'dependency.add') {
      if (current.dependencies.some(item => item.predecessorId === dependency.predecessorId && item.successorId === dependency.successorId)) throw new DomainError('Dependency already exists', 422, 'collision');
      if (cycleWouldExist(current.dependencies, dependency)) throw new DomainError('Dependencies cannot contain a cycle');
      await client.query('INSERT INTO dependencies(predecessor_id, successor_id) VALUES($1, $2)', [dependency.predecessorId, dependency.successorId]);
      current.dependencies.push(dependency);
      return { entityId: dependency.successorId, summary: 'Added dependency', detail: dependency };
    }
    await client.query('DELETE FROM dependencies WHERE predecessor_id = $1 AND successor_id = $2', [dependency.predecessorId, dependency.successorId]);
    await client.query("UPDATE dependency_commitments SET status = 'withdrawn' WHERE predecessor_id = $1 AND successor_id = $2 AND status = 'active'", [dependency.predecessorId, dependency.successorId]);
    return { entityId: dependency.successorId, summary: 'Removed dependency', detail: dependency };
  }
  if (command.type === 'update.add') {
    if (!current.items.some(item => item.id === command.itemId)) throw new DomainError('Update item does not exist');
    const id = freshId();
    await client.query('INSERT INTO updates(id, item_id, author_id, body) VALUES($1, $2, $3, $4)', [id, command.itemId, actor.id, command.body]);
    return { entityId: command.itemId, summary: 'Added work update', detail: { updateId: id } };
  }
  throw new DomainError('Unsupported command');
}

export async function executeCommand(request: CommandRequest, actor: Person): Promise<WorkData> {
  const parsedRequest = commandRequestSchema.parse(request);
  return withTransaction(async client => {
    try {
      const workspace = (await client.query<Row>('SELECT revision FROM workspace WHERE id = 1 FOR UPDATE')).rows[0];
      if (!workspace) throw new DomainError('Workspace is not initialized; run database migration', 503, 'database_uninitialized');
      const revision = Number(workspace.revision);
      if (revision !== parsedRequest.expectedRevision) throw new DomainError('The workspace changed; reload before saving', 409, 'revision_conflict');
      const current = await selectData(client);
      if (!current.people.some(person => person.id === actor.id) || current.people.find(person => person.id === actor.id)?.role !== actor.role) throw new DomainError('Actor is no longer provisioned', 403, 'forbidden');
      const audit = await applyCommand(client, current, parsedRequest, actor);
      const after = await selectData(client);
      try { assertGraph(after); } catch (error) { if (error instanceof DomainError) throw error; throw new DomainError(error instanceof Error ? error.message : 'Portfolio data violates an invariant'); }
      await client.query('UPDATE workspace SET revision = revision + 1, updated_at = now() WHERE id = 1');
      await insertAudit(client, actor.id, parsedRequest.command.type, audit.entityId, audit.summary, audit.detail);
      return selectData(client);
    } catch (error) {
      if (error instanceof DomainError || error instanceof z.ZodError) throw error;
      sqlError(error);
    }
  });
}

// Kept for auth/session modules that need a stable digest without exposing secret material.
export { hashId };
