import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyItem, type Item, type Snapshot, type Update } from '../app/shared/work';
import type { AssessmentEntry } from '../app/shared/work-assessment';
import { buildWorkstreamView, countItems, filterWorkstreamDirectory, hasCurrentDecision, retainAttentionIds, type DecisionAssessment, type DirectoryFilters } from '../app/lib/workstream-view';

const now = Date.parse('2026-10-14T00:00:00.000Z');
const day = (daysAgo: number) => new Date(now - daysAgo * 86_400_000).toISOString();
const item = (id: string, changes: Partial<Item> = {}): Item => ({ ...emptyItem('a'), id, title: id, status: 'doing', createdAt: day(31), updatedAt: day(0), ...changes });
const update = (id: string, itemId: string, daysAgo: number, kind: Update['kind'] = 'note'): Update => ({ id, itemId, authorId: 'person', body: id, kind, assigneeIds: null, createdAt: day(daysAgo) });
function fixture(items: Item[], updates: Update[] = []): Snapshot {
  return { revision: 1, demo: false, people: [], goals: [], tags: [], changes: [], starredItemIds: [], items, updates,
    workstreams: [{ id: 'a', title: 'Alpha', description: 'Launch readiness', leadId: 'lead', goalIds: ['goal'] }, { id: 'b', title: 'Beta', description: '', leadId: null, goalIds: [] }] };
}
function decision(id: string, state: AssessmentEntry['state'] = 'current'): AssessmentEntry {
  return { itemId: id, state, currentInputKey: 'key', assessment: { itemId: id, inputKey: 'key', sourceRevision: 1, version: 'work-assessment-v2', asOf: '2026-10-14', assessedAt: day(0), origin: 'model', requestedModel: 'model', resolvedModel: 'model', labels: { decision: 'needed' } } };
}
function assessment(entries: AssessmentEntry[]): DecisionAssessment {
  return { entriesByItemId: new Map(entries.map(entry => [entry.itemId, entry])), scopeItemIds: new Set(entries.map(entry => entry.itemId)), pendingIds: new Set(), errorsByItemId: new Map(), refreshRequiredIds: new Set() };
}
const filters: DirectoryFilters = { search: '', leadId: '', goalId: '', attention: 'all', sort: 'name' };

test('counts tasks and subtasks separately with current blockers and deduplicated attention', () => {
  const snapshot = fixture([item('parent', { blocker: 'Waiting' }), item('child', { parentId: 'parent', blocker: 'Waiting' }), item('todo', { status: 'todo', blocker: 'Waiting' }), item('done', { status: 'done', blocker: 'Old blocker' })]);
  const view = buildWorkstreamView(snapshot, 7, now, assessment([decision('parent'), decision('done')]));
  assert.deepEqual(view.summaries[0].total, { tasks: 3, subtasks: 1 });
  assert.deepEqual(view.summaries[0].quiet, { tasks: 1, subtasks: 1 });
  assert.deepEqual(view.summaries[0].blocked, { tasks: 2, subtasks: 1 });
  assert.deepEqual(view.summaries[0].attention, { tasks: 2, subtasks: 1 });
  assert.deepEqual(view.reasonsByItemId.get('parent'), ['blocked', 'quiet', 'decision']);
  assert.deepEqual(view.reasonsByItemId.get('todo'), ['blocked']);
  assert.deepEqual(view.reasonsByItemId.get('done'), []);
});

test('Updated uses timeline creation only, not item edits or creation, and includes all timeline kinds', () => {
  const snapshot = fixture([item('edited'), item('new', { createdAt: day(0) }), item('noted'), item('blocked'), item('resolved'), item('done', { status: 'done' })], [update('note', 'noted', 1), update('blocker', 'blocked', 2, 'blocker'), update('resolved', 'resolved', 3, 'blocker_resolved'), update('done', 'done', 4)]);
  assert.deepEqual(buildWorkstreamView(snapshot, 7, now).summaries[0].updated, { tasks: 4, subtasks: 0 });
  assert.equal(countItems(buildWorkstreamView(snapshot, 7, now).summaries[0].blocked), 0);
});

test('7/14/30 windows use the latest timeline or creation and exact boundaries', () => {
  const snapshot = fixture([item('eight'), item('fifteen'), item('thirtyone'), item('boundary'), item('created', { createdAt: day(6) })], [update('eight', 'eight', 8), update('fifteen', 'fifteen', 15), update('boundary', 'boundary', 7)]);
  assert.equal(countItems(buildWorkstreamView(snapshot, 7, now).summaries[0].quiet), 3);
  assert.equal(countItems(buildWorkstreamView(snapshot, 14, now).summaries[0].quiet), 2);
  assert.equal(countItems(buildWorkstreamView(snapshot, 30, now).summaries[0].quiet), 1);
  assert.equal(countItems(buildWorkstreamView(snapshot, 7, now).summaries[0].updated), 1);
});

test('latest timeline selection is chronological, deterministic and does not mutate the snapshot', () => {
  const updates = [update('older', 'one', 20), update('z', 'one', 1), update('a', 'one', 1)];
  const snapshot = fixture([item('one')], updates);
  const before = JSON.stringify(snapshot);
  const view = buildWorkstreamView(snapshot, 7, now);
  assert.deepEqual(view.historyByItemId.get('one')?.map(value => value.id), ['z', 'a', 'older']);
  assert.equal(view.summaries[0].latestTimelineAt, Date.parse(day(1)));
  assert.equal(JSON.stringify(snapshot), before);
});

test('SSR null clock defers window metrics and invalid or future timestamps do not count as Updated', () => {
  const snapshot = fixture([item('one'), item('future'), item('invalid', { createdAt: 'invalid' })], [update('one', 'one', 1), update('future', 'future', -1)]);
  const view = buildWorkstreamView(snapshot, 7, null);
  assert.equal(countItems(view.summaries[0].updated), 0);
  assert.equal(countItems(view.summaries[0].quiet), 0);
  assert.equal(countItems(buildWorkstreamView(snapshot, 7, now).summaries[0].updated), 1);
});

test('decision flags require a current matching entry in scope without pending/error/refresh state', () => {
  const base = assessment([decision('one')]);
  assert.equal(hasCurrentDecision('one', base), true);
  for (const state of ['stale', 'missing', 'not_applicable'] as const) assert.equal(hasCurrentDecision('one', assessment([decision('one', state)])), false);
  assert.equal(hasCurrentDecision('one', { ...base, scopeItemIds: new Set() }), false);
  assert.equal(hasCurrentDecision('one', { ...base, pendingIds: new Set(['one']) }), false);
  assert.equal(hasCurrentDecision('one', { ...base, refreshRequiredIds: new Set(['one']) }), false);
  assert.equal(hasCurrentDecision('one', { ...base, errorsByItemId: new Map([['one', { message: 'Failed' }]]) }), false);
  assert.equal(hasCurrentDecision('one', assessment([{ ...decision('one'), currentInputKey: 'different' }])), false);
  assert.equal(hasCurrentDecision('one'), false);
});

test('directory combines description/title search, lead, goal, attention and stable sorts', () => {
  const snapshot = fixture([item('one'), item('two', { workstreamId: 'b', status: 'todo' })], [update('recent', 'two', 1)]);
  const view = buildWorkstreamView(snapshot, 7, now, assessment([decision('two')]));
  const ids = (changes: Partial<DirectoryFilters>) => filterWorkstreamDirectory(view, snapshot, { ...filters, ...changes }).map(value => value.stream.id);
  assert.deepEqual(ids({ search: 'READINESS', leadId: 'lead', goalId: 'goal', attention: 'quiet' }), ['a']);
  assert.deepEqual(ids({ search: 'beta' }), ['b']);
  assert.deepEqual(ids({ goalId: 'missing' }), []);
  assert.deepEqual(ids({ attention: 'decision' }), ['b']);
  assert.deepEqual(ids({ sort: 'latest' }), ['b', 'a']);
  assert.deepEqual(ids({ sort: 'quiet' }), ['a', 'b']);
  assert.deepEqual(ids({ attention: 'blocked' }), []);
});

test('retention preserves newly unflagged and completed entries while current counts remain accurate', () => {
  const initial = fixture([item('one', { blocker: 'Waiting' }), item('child', { parentId: 'one' })]);
  const previous = new Set(['one', 'child']);
  const next = fixture([item('one', { status: 'done' }), item('child', { parentId: 'one', status: 'todo' }), item('new', { blocker: 'Waiting' })]);
  const view = buildWorkstreamView(next, 7, now);
  const current = new Set([...view.reasonsByItemId].filter(([, reasons]) => reasons.length).map(([id]) => id));
  assert.deepEqual([...retainAttentionIds(next, 'a', previous, current)], ['one', 'child', 'new']);
  assert.equal(countItems(view.summaries[0].attention), 1);
  assert.deepEqual([...retainAttentionIds(next, 'a', new Set(), current)], ['new']);
  assert.deepEqual([...retainAttentionIds(initial, 'b', previous, new Set())], []);
  assert.deepEqual([...retainAttentionIds(fixture([]), 'a', previous, new Set())], []);
});
