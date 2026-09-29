import {
  ASSESSMENT_QUESTIONS,
  ASSESSMENT_VERSION,
  assessmentDetailsSchema,
  assessmentIndexSchema,
  assessmentInputKey,
  assessmentModelState,
  assessmentRecordSchema,
  assessmentResponseSchema,
  assessmentRunRequestSchema,
  assessmentScopeSchema,
  assessmentScopeResponseSchema,
  buildAssessmentInput,
  isThinAssessmentInput,
  labelsFromAssessmentResponse,
  assessmentPreferenceResponseSchema,
} from '../shared/work-assessment';
import type { AssessmentDetails, AssessmentIndex, AssessmentInput, AssessmentRecord, AssessmentResponse, AssessmentScope, AssessmentSummary } from '../shared/work-assessment';
import { matchesBaseWorkFilters } from '../shared/work-filters';
import type { Person, Snapshot } from '../shared/work';
import { withTransaction, pool } from './db.server';
import { AssistError, assistStatus, requestSystemOne, type OpenJevRequest, type OpenJevResponse } from './work-assist.server';
import { readWork, readWorkInTransaction, WorkError } from './work.server';

const MAX_IN_FLIGHT_ASSESSMENTS = 2;
const MAX_REQUEST_BYTES = 65_536;
type Row = Record<string, any>;
type ProviderResult = { response: OpenJevResponse; roundtripMs: number };
type AssessmentClock = { serverNow: string; asOf: string };
type PreparedAssessment = { actor: Person; snapshot: Snapshot; input: AssessmentInput; inputKey: string; model: string };
type InFlight = { promise: Promise<ProviderResult>; consumers: number };

const inFlight = new Map<string, InFlight>();

function readAssessmentClock(): AssessmentClock {
  const now = new Date();
  const serverNow = now.toISOString();
  return { serverNow, asOf: serverNow.slice(0, 10) };
}

function assessmentFailure(message: string, status: number, code: string): never {
  throw new WorkError(message, status, code);
}

function parseStoredRecord(value: unknown, itemId: string): AssessmentRecord {
  const parsed = assessmentRecordSchema.safeParse(value);
  if (!parsed.success || parsed.data.itemId !== itemId) assessmentFailure('A saved assessment record is invalid; no current assessment is shown.', 500, 'assessment_record_invalid');
  return parsed.data;
}

function parseStoredRow(row: Row, itemId: string): AssessmentRecord {
  const record = parseStoredRecord(row.record, itemId);
  if (String(row.input_key) !== record.inputKey) assessmentFailure('A saved assessment record is invalid; no current assessment is shown.', 500, 'assessment_record_invalid');
  return record;
}

async function readStoredRecords(): Promise<Map<string, AssessmentRecord>> {
  const result = await pool.query<Row>('SELECT item_id, input_key, record FROM simple_work_assessments');
  const records = new Map<string, AssessmentRecord>();
  for (const row of result.rows) records.set(String(row.item_id), parseStoredRow(row, String(row.item_id)));
  return records;
}

function parseStoredScope(value: unknown): AssessmentScope | null {
  if (value === null || value === undefined) return null;
  const parsed = assessmentScopeSchema.safeParse(value);
  if (!parsed.success) assessmentFailure('A saved assessment scope is invalid; assessments are disabled until it is replaced.', 500, 'assessment_scope_invalid');
  return parsed.data as AssessmentScope;
}

type PreferenceState = { enabled: boolean; scope: AssessmentScope | null };

async function readPreferenceState(personId: string): Promise<PreferenceState> {
  const result = await pool.query<Row>('SELECT enabled, scope FROM simple_work_assessment_preferences WHERE person_id = $1', [personId]);
  const row = result.rows[0];
  if (!row) return { enabled: false, scope: null };
  return { enabled: Boolean(row.enabled), scope: parseStoredScope(row.scope) };
}

function summaryFromRecord(record: AssessmentRecord): AssessmentSummary {
  return {
    itemId: record.itemId,
    inputKey: record.inputKey,
    sourceRevision: record.sourceRevision,
    version: record.version,
    asOf: record.asOf,
    assessedAt: record.assessedAt,
    origin: record.origin,
    requestedModel: record.requestTemplate.model,
    resolvedModel: record.response?.model ?? null,
    labels: record.labels,
  };
}

function scopedActiveItemIds(snapshot: Snapshot, scope: AssessmentScope | null, userId: string, asOf: string): string[] {
  if (!scope) return [];
  return snapshot.items.filter(item => item.status !== 'done' && matchesBaseWorkFilters(item, snapshot, scope, scope.scope, userId, asOf)).map(item => item.id);
}

function assertInRunScope(snapshot: Snapshot, itemId: string, scope: AssessmentScope | null, userId: string, asOf: string): void {
  if (!scope) assessmentFailure('Configure an assessment scope before enabling assessments.', 409, 'assessment_scope_required');
  const item = snapshot.items.find(value => value.id === itemId);
  if (!item || item.status === 'done') return;
  if (!matchesBaseWorkFilters(item, snapshot, scope, scope.scope, userId, asOf)) assessmentFailure('This work item is outside your saved assessment scope.', 403, 'assessment_out_of_scope');
}

async function activeCurrentKey(snapshot: Snapshot, itemId: string, clock: AssessmentClock, provider: { enabled: boolean; model: string | null }): Promise<string | null> {
  const item = snapshot.items.find(value => value.id === itemId);
  if (!item || item.status === 'done' || !provider.enabled || !provider.model) return null;
  const input = buildAssessmentInput(snapshot, itemId, clock.asOf);
  if (!input) return null;
  return assessmentInputKey(input, provider.model);
}

function entryState(snapshot: Snapshot, itemId: string, currentKey: string | null, record: AssessmentRecord | undefined): AssessmentIndex['entries'][number] {
  const item = snapshot.items.find(value => value.id === itemId);
  const summary = record ? summaryFromRecord(record) : null;
  if (item?.status === 'done') return { itemId, currentInputKey: null, state: 'not_applicable', assessment: summary };
  if (!record) return { itemId, currentInputKey: currentKey, state: 'missing', assessment: null };
  if (!currentKey) return { itemId, currentInputKey: null, state: 'stale', assessment: summary };
  if (record.version === ASSESSMENT_VERSION && record.inputKey === currentKey) return { itemId, currentInputKey: currentKey, state: 'current', assessment: summary };
  return { itemId, currentInputKey: currentKey, state: 'stale', assessment: summary };
}

async function sourceContextFor(snapshot: Snapshot, record: AssessmentRecord): Promise<AssessmentInput | null> {
  const context = buildAssessmentInput(snapshot, record.itemId, record.asOf);
  if (!context) return null;
  return await assessmentInputKey(context, record.requestTemplate.model) === record.inputKey ? context : null;
}

async function readAssessmentDetails(actor: Person, itemId: string): Promise<AssessmentDetails> {
  const snapshot = await readWork(actor);
  if (!snapshot.items.some(value => value.id === itemId)) assessmentFailure('Work item not found.', 404, 'not_found');
  const clock = readAssessmentClock();
  const status = assistStatus();
  const records = await readStoredRecords();
  const record = records.get(itemId);
  const currentKey = await activeCurrentKey(snapshot, itemId, clock, { enabled: status.enabled, model: status.model });
  const entry = entryState(snapshot, itemId, currentKey, record);
  const sourceContext = record ? await sourceContextFor(snapshot, record) : null;
  return assessmentDetailsSchema.parse({ serverNow: clock.serverNow, asOf: clock.asOf, entry, record: record ?? null, sourceContext });
}

export async function readWorkAssessments(actor: Person, itemId?: string): Promise<AssessmentIndex | AssessmentDetails> {
  if (itemId !== undefined) return readAssessmentDetails(actor, itemId);
  const snapshot = await readWork(actor);
  const clock = readAssessmentClock();
  const status = assistStatus();
  const provider = { enabled: status.enabled, model: status.model };
  const preference = await readPreferenceState(actor.id);
  const records = await readStoredRecords();
  const entries = [];
  for (const item of snapshot.items) {
    const currentKey = await activeCurrentKey(snapshot, item.id, clock, provider);
    entries.push(entryState(snapshot, item.id, currentKey, records.get(item.id)));
  }
  return assessmentIndexSchema.parse({ enabled: preference.enabled, provider, serverNow: clock.serverNow, asOf: clock.asOf, scope: preference.scope, scopeItemIds: scopedActiveItemIds(snapshot, preference.scope, actor.id, clock.asOf), entries });
}

export async function setWorkAssessmentScope(actor: Person, scope: AssessmentScope): Promise<{ scope: AssessmentScope }> {
  const parsed = assessmentScopeSchema.safeParse(scope);
  if (!parsed.success) assessmentFailure('Check the assessment scope fields.', 422, 'invalid_request');
  return withTransaction(async client => {
    await client.query('SELECT id FROM simple_workspace WHERE id = 1 FOR UPDATE');
    const snapshot = await readWorkInTransaction(client, actor);
    const current = snapshot.people.find(person => person.id === actor.id);
    if (!current || current.role === 'viewer') assessmentFailure('Editors or administrators are required to configure assessment scope.', 403, 'forbidden');
    await client.query(`INSERT INTO simple_work_assessment_preferences(person_id, enabled, scope) VALUES($1, false, $2::jsonb)
      ON CONFLICT(person_id) DO UPDATE SET scope = EXCLUDED.scope`, [current.id, JSON.stringify(parsed.data)]);
    return assessmentScopeResponseSchema.parse({ scope: parsed.data });
  });
}

export async function setWorkAssessmentsEnabled(actor: Person, enabled: boolean): Promise<{ enabled: boolean }> {
  return withTransaction(async client => {
    if (enabled) await client.query('SELECT id FROM simple_workspace WHERE id = 1 FOR SHARE');
    const snapshot = await readWorkInTransaction(client, actor);
    const current = snapshot.people.find(person => person.id === actor.id);
    if (!current) assessmentFailure('Your account is no longer provisioned.', 403, 'forbidden');
    const preferenceRow = (await client.query<Row>('SELECT enabled, scope FROM simple_work_assessment_preferences WHERE person_id = $1 FOR UPDATE', [current.id])).rows[0];
    const storedScope = preferenceRow?.scope;
    const scope = enabled ? parseStoredScope(storedScope) : null;
    if (enabled && current.role === 'viewer') assessmentFailure('Editors or administrators are required to run assessments.', 403, 'forbidden');
    if (enabled && !scope) assessmentFailure('Configure an assessment scope before enabling assessments.', 409, 'assessment_scope_required');
    if (enabled && !assistStatus().enabled) throw new AssistError('Assessments are unavailable because the private model is not configured.', 503, 'assist_unavailable');
    const scopeJson = enabled ? (scope ? JSON.stringify(scope) : null) : storedScope === null || storedScope === undefined ? null : JSON.stringify(storedScope);
    await client.query('INSERT INTO simple_work_assessment_preferences(person_id, enabled, scope) VALUES($1, $2, $3::jsonb) ON CONFLICT(person_id) DO UPDATE SET enabled = EXCLUDED.enabled', [current.id, enabled, scopeJson]);
    return assessmentPreferenceResponseSchema.parse({ enabled });
  });
}


async function prepareAssessment(actor: Person, request: unknown): Promise<PreparedAssessment> {
  const parsed = assessmentRunRequestSchema.safeParse(request);
  if (!parsed.success) assessmentFailure('Check the assessment request fields.', 422, 'invalid_request');
  const snapshot = await readWork(actor);
  const current = snapshot.people.find(person => person.id === actor.id);
  if (!current || current.role === 'viewer') assessmentFailure('Editors or administrators are required to run assessments.', 403, 'forbidden');
  const preference = await readPreferenceState(current.id);
  if (!preference.enabled) assessmentFailure('Automatic assessments are off for this account.', 403, 'assessment_disabled');
  if (!preference.scope) assessmentFailure('Configure an assessment scope before enabling assessments.', 409, 'assessment_scope_required');
  const clock = readAssessmentClock();
  const input = buildAssessmentInput(snapshot, parsed.data.itemId, clock.asOf);
  if (!input) assessmentFailure('Work item not found.', 404, 'not_found');
  if (input.item.status === 'done') return { actor: current, snapshot, input, inputKey: parsed.data.inputKey, model: '' };
  assertInRunScope(snapshot, parsed.data.itemId, preference.scope, current.id, clock.asOf);
  const status = assistStatus();
  if (!status.enabled || !status.model) throw new AssistError('Assessments are unavailable because the private model is not configured.', 503, 'assist_unavailable');
  const inputKey = await assessmentInputKey(input, status.model);
  if (inputKey !== parsed.data.inputKey) assessmentFailure('The saved work changed; refresh before assessing it.', 409, 'assessment_source_changed');
  return { actor: current, snapshot, input, inputKey, model: status.model };
}

function assessmentPayload(input: AssessmentInput): Omit<OpenJevRequest, 'model'> {
  return { state: assessmentModelState(input) as unknown as Record<string, unknown>, questions: ASSESSMENT_QUESTIONS as unknown as OpenJevRequest['questions'] };
}

function assertAssessmentRequestFits(model: string, payload: Omit<OpenJevRequest, 'model'>): void {
  let serialized: string | undefined;
  try { serialized = JSON.stringify({ model, ...payload }); } catch { /* handled as a bounded-context failure */ }
  if (!serialized || new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) assessmentFailure('The assessment context is too large to send; authored work was not changed.', 422, 'assessment_context_too_large');
}

function acquireProvider(key: string, model: string, payload: Omit<OpenJevRequest, 'model'>): { entry: InFlight; release: () => void } {
  let entry = inFlight.get(key);
  if (!entry) {
    if (inFlight.size >= MAX_IN_FLIGHT_ASSESSMENTS) throw new WorkError('Another assessment is already running; try again shortly.', 429, 'assessment_busy');
    entry = { promise: requestSystemOne(payload, model), consumers: 0 };
    inFlight.set(key, entry);
  }
  entry.consumers += 1;
  const retained = entry;
  return {
    entry: retained,
    release: () => {
      retained.consumers -= 1;
      if (retained.consumers <= 0 && inFlight.get(key) === retained) inFlight.delete(key);
    },
  };
}

function responseForAssessment(response: OpenJevResponse): AssessmentResponse {
  const parsed = assessmentResponseSchema.safeParse({ model: response.model, answers: { decision: response.answers.decision } });
  if (!parsed.success) throw new AssistError('The local model returned an invalid assessment response.', 502, 'assist_output_invalid');
  return parsed.data;
}

async function finalizeAssessment(actor: Person, itemId: string, expectedKey: string, expectedModel: string, provider: ProviderResult | null): Promise<AssessmentRecord> {
  return withTransaction(async client => {
    await client.query('SELECT revision FROM simple_workspace WHERE id = 1 FOR SHARE');
    const snapshot = await readWorkInTransaction(client, actor);
    const current = snapshot.people.find(person => person.id === actor.id);
    if (!current || current.role === 'viewer') assessmentFailure('Editors or administrators are required to run assessments.', 403, 'forbidden');
    const preferenceRow = (await client.query<Row>('SELECT enabled, scope FROM simple_work_assessment_preferences WHERE person_id = $1 FOR SHARE', [current.id])).rows[0];
    const scope = parseStoredScope(preferenceRow?.scope);
    if (!preferenceRow?.enabled) assessmentFailure('Automatic assessments are off for this account.', 403, 'assessment_disabled');
    if (!scope) assessmentFailure('Configure an assessment scope before enabling assessments.', 409, 'assessment_scope_required');
    const status = assistStatus();
    if (!status.enabled || !status.model) throw new AssistError('Assessments are unavailable because the private model is not configured.', 503, 'assist_unavailable');
    if (status.model !== expectedModel) throw new AssistError('The configured assessment model changed; refresh and try again.', 409, 'assessment_model_changed');
    const clock = readAssessmentClock();
    const input = buildAssessmentInput(snapshot, itemId, clock.asOf);
    if (!input) assessmentFailure('Work item not found.', 404, 'not_found');
    assertInRunScope(snapshot, itemId, scope, current.id, clock.asOf);
    if (input.item.status === 'done') assessmentFailure('The saved work changed; refresh before assessing it.', 409, 'assessment_source_changed');
    const finalKey = await assessmentInputKey(input, status.model);
    if (finalKey !== expectedKey) assessmentFailure('The saved work changed; refresh before assessing it.', 409, 'assessment_source_changed');
    const existingRow = (await client.query<Row>('SELECT input_key, record FROM simple_work_assessments WHERE item_id = $1', [itemId])).rows[0];
    if (existingRow) {
      const existing = parseStoredRow(existingRow, itemId);
      if (existing.inputKey === finalKey) return existing;
    }
    if (!provider && !isThinAssessmentInput(input)) assessmentFailure('The saved work changed; refresh before assessing it.', 409, 'assessment_source_changed');
    const parsedProvider = provider ? responseForAssessment(provider.response) : null;
    const record = assessmentRecordSchema.parse({
      itemId,
      inputKey: finalKey,
      sourceRevision: snapshot.revision,
      version: ASSESSMENT_VERSION,
      asOf: clock.asOf,
      assessedAt: clock.serverNow,
      origin: parsedProvider ? 'model' : 'rules',
      roundtripMs: parsedProvider ? provider!.roundtripMs : null,
      labels: parsedProvider ? labelsFromAssessmentResponse(parsedProvider) : { decision: 'unclear' },
      requestTemplate: { model: status.model, questions: ASSESSMENT_QUESTIONS },
      response: parsedProvider,
    });
    const inserted = await client.query<Row>(`INSERT INTO simple_work_assessments(item_id, input_key, record) VALUES($1, $2, $3::jsonb)
      ON CONFLICT (item_id) DO UPDATE SET input_key = EXCLUDED.input_key, record = EXCLUDED.record
      WHERE simple_work_assessments.input_key <> EXCLUDED.input_key RETURNING input_key, record`, [itemId, finalKey, JSON.stringify(record)]);
    if (inserted.rows[0]) return parseStoredRow(inserted.rows[0], itemId);
    const saved = (await client.query<Row>('SELECT input_key, record FROM simple_work_assessments WHERE item_id = $1', [itemId])).rows[0];
    if (!saved) assessmentFailure('The assessment could not be saved.', 500, 'assessment_save_failed');
    return parseStoredRow(saved, itemId);
  });
}

export async function assessWorkItem(actor: Person, request: { itemId: string; inputKey: string }): Promise<AssessmentDetails> {
  const prepared = await prepareAssessment(actor, request);
  if (prepared.input.item.status === 'done') return readAssessmentDetails(actor, request.itemId);
  const cached = (await pool.query<Row>('SELECT input_key, record FROM simple_work_assessments WHERE item_id = $1', [request.itemId])).rows[0];
  if (cached) {
    const record = parseStoredRow(cached, request.itemId);
    if (record.inputKey === prepared.inputKey) {
      await finalizeAssessment(actor, request.itemId, prepared.inputKey, prepared.model, null);
      return readAssessmentDetails(actor, request.itemId);
    }
  }
  if (isThinAssessmentInput(prepared.input)) {
    await finalizeAssessment(actor, request.itemId, prepared.inputKey, prepared.model, null);
    return readAssessmentDetails(actor, request.itemId);
  }
  const payload = assessmentPayload(prepared.input);
  assertAssessmentRequestFits(prepared.model, payload);
  const acquired = acquireProvider(prepared.inputKey, prepared.model, payload);
  try {
    const result = await acquired.entry.promise;
    await finalizeAssessment(actor, request.itemId, prepared.inputKey, prepared.model, result);
    return readAssessmentDetails(actor, request.itemId);
  } finally {
    acquired.release();
  }
}
