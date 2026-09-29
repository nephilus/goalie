import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSESSMENT_QUESTIONS,
  ASSESSMENT_VERSION,
  assessmentInputKey,
  assessmentInputSchema,
  assessmentModelState,
  assessmentRecordSchema,
  assessmentResponseSchema,
  assessmentRunRequestSchema,
  assessmentScopeRequestSchema,
  assessmentScopeSchema,
  assessmentSummarySchema,
  buildAssessmentInput,
  isThinAssessmentInput,
  labelsFromAssessmentResponse,
  type AssessmentInput,
} from '../app/shared/work-assessment';
import { DEFAULT_WORK_FILTERS, calendarDaysBetween, matchesBaseWorkFilters, workFiltersSchema } from '../app/shared/work-filters';
import { emptyItem, type Snapshot } from '../app/shared/work';
import { startSystemOneFixture } from './helpers/systemone-fixture';

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  const item = { ...emptyItem('stream'), id: 'item', title: 'Deliver launch', description: 'Execution context.', status: 'doing' as const, blocker: 'Approval is pending.', parentId: null, assigneeIds: ['person'], tagIds: ['tag'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' };
  return {
    revision: 12,
    demo: false,
    people: [{ id: 'person', name: 'Person', email: 'person@example.test', role: 'editor' }],
    goals: [{ id: 'goal', title: 'Outcome', description: 'Goal context', targetDate: '2026-12-01' }],
    workstreams: [{ id: 'stream', title: 'Delivery', description: 'Delivery context', leadId: 'person', goalIds: ['goal'] }],
    items: [item],
    tags: [{ id: 'tag', name: 'private', description: 'Do not send', workstreamId: 'stream' }],
    updates: [{ id: 'u1', itemId: 'item', authorId: 'person', body: 'Waiting for review.', kind: 'note', assigneeIds: ['person'], createdAt: '2026-09-28T00:00:00.000Z' }],
    changes: [{ id: 'change', actorId: 'person', action: 'item.update', entityId: 'item', createdAt: '2026-09-28T00:00:00.000Z' }],
    starredItemIds: ['item'],
    ...overrides,
  };
}

function modelResponse() {
  return { model: 'openjev-fixture', answers: { decision: { type: 'choice' as const, choice: 'needed', probabilities: { needed: 1, not_evidenced: 0, unclear: 0 } } } };
}

function currentRecord(input: AssessmentInput) {
  return assessmentRecordSchema.parse({ itemId: input.item.id, inputKey: 'a'.repeat(64), sourceRevision: 12, version: ASSESSMENT_VERSION, asOf: input.asOf, assessedAt: '2026-09-28T12:00:00.000Z', origin: 'model', roundtripMs: 12.5, labels: { decision: 'needed' }, requestTemplate: { model: 'openjev-fixture', questions: ASSESSMENT_QUESTIONS }, response: modelResponse() });
}

test('UTC day arithmetic remains available independently of assessment context', () => {
  assert.equal(calendarDaysBetween('2026-09-28', '2026-09-26'), -2);
  assert.equal(calendarDaysBetween('2026-09-28', '2026-10-01'), 3);
  assert.throws(() => calendarDaysBetween('2026-02-30', '2026-10-01'));
});

test('shared work matcher preserves multi-select semantics and account scope', () => {
  const data = snapshot({
    people: [
      ...snapshot().people,
      { id: 'other-person', name: 'Other Person', email: 'other@example.test', role: 'editor' },
    ],
    goals: [
      ...snapshot().goals,
      { id: 'other-goal', title: 'Other outcome', description: 'Other goal context', targetDate: '2026-12-02' },
    ],
    workstreams: [
      ...snapshot().workstreams,
      { id: 'other-stream', title: 'Other stream', description: 'Other stream context', leadId: 'other-person', goalIds: ['other-goal'] },
    ],
    tags: [
      ...snapshot().tags,
      { id: 'platform', name: 'Platform', description: 'Platform work', workstreamId: null },
    ],
    items: [
      { ...snapshot().items[0], dueDate: '2026-10-01' },
      { ...snapshot().items[0], id: 'todo', status: 'todo', assigneeIds: ['other-person'], tagIds: ['platform'], workstreamId: 'other-stream', dueDate: null },
      { ...snapshot().items[0], id: 'done', status: 'done', dueDate: '2026-10-01' },
    ],
  });
  const doing = data.items[0]!;
  const todo = data.items[1]!;
  const done = data.items[2]!;
  assert.equal(workFiltersSchema.parse({ ...DEFAULT_WORK_FILTERS, search: 'person' }).search, 'person');
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, search: 'person' }, 'all', 'other-person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS }, 'mine', 'other-person', '2026-09-28'), false);
  assert.equal(matchesBaseWorkFilters(done, data, { ...DEFAULT_WORK_FILTERS }, 'all', 'person', '2026-09-28'), true);
  const child = { ...doing, id: 'child', title: 'Child task', parentId: doing.id, status: 'todo' as const };
  data.items.push(child);
  const childFilter: typeof DEFAULT_WORK_FILTERS = { ...DEFAULT_WORK_FILTERS, statuses: ['todo'] };
  assert.equal(matchesBaseWorkFilters(doing, data, childFilter, 'all', 'person', '2026-09-28'), false);
  assert.equal(matchesBaseWorkFilters(child, data, childFilter, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, statuses: ['todo', 'doing'] }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(todo, data, { ...DEFAULT_WORK_FILTERS, statuses: ['todo', 'doing'] }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(done, data, { ...DEFAULT_WORK_FILTERS, statuses: ['todo', 'doing'] }, 'all', 'person', '2026-09-28'), false);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, tagIds: ['platform', 'tag'] }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(todo, data, { ...DEFAULT_WORK_FILTERS, tagIds: ['platform', 'tag'] }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, workstreamIds: ['stream', 'other-stream'], goalIds: ['goal', 'other-goal'] }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(todo, data, { ...DEFAULT_WORK_FILTERS, goalIds: ['goal', 'other-goal'] }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(todo, data, { ...DEFAULT_WORK_FILTERS, workstreamIds: ['stream'], goalIds: ['goal'] }, 'all', 'person', '2026-09-28'), false);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, goalIds: ['unavailable'] }, 'all', 'person', '2026-09-28'), false);
  assert.equal(matchesBaseWorkFilters(todo, data, { ...DEFAULT_WORK_FILTERS, assigneeIds: ['person', 'other-person'] }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, assigneeIds: ['unavailable', 'person'] }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, workstreamIds: ['unavailable'] }, 'all', 'person', '2026-09-28'), false);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, dueTiming: 'due_soon' }, 'all', 'person', '2026-09-28'), true);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, dueTiming: 'later' }, 'all', 'person', '2026-09-28'), false);
  assert.equal(matchesBaseWorkFilters(doing, data, { ...DEFAULT_WORK_FILTERS, starredOnly: true }, 'all', 'person', '2026-09-28'), true);
  assert.throws(() => workFiltersSchema.parse({ ...DEFAULT_WORK_FILTERS, workstreamIds: ['stream', 'stream'] }));
  assert.throws(() => workFiltersSchema.parse({ ...DEFAULT_WORK_FILTERS, statuses: ['todo', 'todo'] }));
  assert.throws(() => workFiltersSchema.parse({ ...DEFAULT_WORK_FILTERS, tagIds: [''] }));
  assert.throws(() => workFiltersSchema.parse({ ...DEFAULT_WORK_FILTERS, workstreamId: 'stream' }));
  assert.throws(() => workFiltersSchema.parse({ ...DEFAULT_WORK_FILTERS, unknown: true }));
});

test('input builder preserves latest twenty updates and database order', () => {
  const data = snapshot({ updates: Array.from({ length: 22 }, (_, index) => ({ id: `u${index}`, itemId: 'item', authorId: 'person', body: `Update ${index}`, kind: 'note' as const, assigneeIds: ['person'], createdAt: '2026-09-28T00:00:00.000Z' })) });
  const input = buildAssessmentInput(data, 'item', '2026-09-28')!;
  assert.equal(input.updates.length, 20);
  assert.equal(input.updates[0].id, 'u2');
  assert.equal(input.updates.at(-1)?.id, 'u21');
  assert.equal(input.updatesOmittedCount, 2);
  assert.equal(input.historyComplete, false);
});

test('decision input is exact and model state strips identity-only IDs', () => {
  const input = buildAssessmentInput(snapshot(), 'item', '2026-09-28')!;
  assert.deepEqual(Object.keys(input), ['asOf', 'item', 'updates', 'updatesOmittedCount', 'historyComplete']);
  assert.deepEqual(Object.keys(input.item), ['id', 'title', 'description', 'status', 'blocker']);
  assert.deepEqual(Object.keys(input.updates[0]), ['id', 'kind', 'body', 'createdAt']);
  assert.deepEqual(Object.keys(assessmentModelState(input)), ['asOf', 'item', 'updates', 'updatesOmittedCount', 'historyComplete']);
  assert.equal('id' in assessmentModelState(input).item, false);
  assert.equal('id' in assessmentModelState(input).updates[0], false);
  assert.equal(JSON.stringify(input).includes('person@example.test'), false);
  assert.equal(JSON.stringify(input).includes('private'), false);
  assert.equal(buildAssessmentInput(snapshot(), 'missing', '2026-09-28'), null);
});

test('input identity retains local item/update isolation while model state omits IDs', async () => {
  const base = buildAssessmentInput(snapshot(), 'item', '2026-09-28')!;
  const baseKey = await assessmentInputKey(base, 'openjev-fixture');
  const changedItem = snapshot({ items: [{ ...snapshot().items[0], id: 'other' }] });
  const changedUpdate = snapshot({ updates: [{ ...snapshot().updates[0], id: 'other-update' }] });
  assert.notEqual(await assessmentInputKey(buildAssessmentInput(changedItem, 'other', '2026-09-28')!, 'openjev-fixture'), baseKey);
  assert.notEqual(await assessmentInputKey(buildAssessmentInput(changedUpdate, 'item', '2026-09-28')!, 'openjev-fixture'), baseKey);
  assert.notEqual(await assessmentInputKey({ ...base, item: { ...base.item, description: 'Changed' } }, 'openjev-fixture'), baseKey);
  assert.notEqual(await assessmentInputKey(base, 'another-model'), baseKey);
  assert.notEqual(await assessmentInputKey(buildAssessmentInput(snapshot(), 'item', '2026-09-29')!, 'openjev-fixture'), baseKey);
});

test('title-only and completed gates are deterministic', () => {
  const thin = buildAssessmentInput(snapshot({ items: [{ ...snapshot().items[0], description: '', blocker: '', status: 'doing' }], updates: [] }), 'item', '2026-09-28')!;
  assert.equal(isThinAssessmentInput(thin), true);
  assert.deepEqual(labelsFromAssessmentResponse(assessmentResponseSchema.parse({ model: 'openjev-fixture', answers: { decision: { type: 'choice', choice: 'unclear', probabilities: { needed: 0, not_evidenced: 0, unclear: 1 } } } })), { decision: 'unclear' });
  assert.equal(isThinAssessmentInput(buildAssessmentInput(snapshot({ items: [{ ...snapshot().items[0], status: 'done' }] }), 'item', '2026-09-28')!), false);
});

test('strict schemas reject legacy dimensions, arbitrary fields, and malformed results', () => {
  assert.throws(() => assessmentRunRequestSchema.parse({ itemId: 'item', inputKey: 'a'.repeat(64), extra: true }));
  const scope = { ...DEFAULT_WORK_FILTERS, scope: 'all' as const };
  assert.deepEqual(assessmentScopeSchema.parse(scope), scope);
  assert.deepEqual(assessmentScopeRequestSchema.parse({ scope }).scope, scope);
  assert.throws(() => assessmentScopeSchema.parse({ ...scope, workstreamId: '' }));
  assert.throws(() => assessmentScopeRequestSchema.parse({ scope, extra: true }));
  assert.throws(() => assessmentInputSchema.parse({ ...buildAssessmentInput(snapshot(), 'item', '2026-09-28')!, periodEnd: '2026-10-28' }));
  assert.throws(() => assessmentSummarySchema.parse({ itemId: 'item', inputKey: 'a'.repeat(64), sourceRevision: 1, version: ASSESSMENT_VERSION, asOf: '2026-09-28', periodEnd: '2026-10-28', assessedAt: '2026-09-28T00:00:00.000Z', origin: 'model', requestedModel: 'openjev-fixture', resolvedModel: null, labels: { decision: 'needed' } }));
  const input = buildAssessmentInput(snapshot(), 'item', '2026-09-28')!;
  const record = currentRecord(input);
  assert.deepEqual(record.labels, { decision: 'needed' });
  assert.throws(() => assessmentRecordSchema.parse({ ...record, version: 'work-assessment-v1' }));
  assert.throws(() => assessmentRecordSchema.parse({ ...record, labels: { decision: 'unclear' } }));
  assert.throws(() => assessmentRecordSchema.parse({ ...record, origin: 'rules', response: null, roundtripMs: null, labels: { decision: 'needed' } }));
});

test('the disposable provider fixture requires its bearer and accepts only decision rubric', async () => {
  const fixture = await startSystemOneFixture({ port: 0, apiKey: 'fixture-secret' });
  try {
    const unauthorized = await fetch(`${fixture.origin}/__fixture/requests`);
    assert.equal(unauthorized.status, 401);
    const oversized = await fetch(`${fixture.origin}/v1/systemone`, { method: 'POST', headers: { authorization: 'Bearer fixture-secret', 'content-type': 'application/json' }, body: JSON.stringify({ state: { item: { title: 'oversized' } }, questions: ASSESSMENT_QUESTIONS, padding: 'x'.repeat(70_000) }) });
    assert.equal(oversized.status, 413);
    assert.equal((await fixture.requests()).length, 0);
    const response = await fetch(`${fixture.origin}/v1/systemone`, { method: 'POST', headers: { authorization: 'Bearer fixture-secret', 'content-type': 'application/json' }, body: JSON.stringify({ state: { asOf: '2026-09-28', item: { title: 'Example' }, updates: [{ kind: 'note', body: 'Context', createdAt: '2026-09-28T00:00:00.000Z' }], updatesOmittedCount: 0, historyComplete: true }, questions: ASSESSMENT_QUESTIONS }) });
    assert.equal(response.status, 200);
    const captured = await fixture.requests();
    const capturedRequest = captured[0]!;
    const sentState = (capturedRequest.request as { state: { item: Record<string, unknown>; updates: Array<Record<string, unknown>> } }).state;
    assert.equal('id' in sentState.item, false);
    assert.equal('id' in sentState.updates[0]!, false);
    const responseBody = await response.json() as { answers: { decision: { choice: string } } };
    assert.equal(responseBody.answers.decision.choice, 'unclear');
  } finally {
    await fixture.close();
  }
});
