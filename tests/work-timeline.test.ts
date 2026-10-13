import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AdrTimelineContent } from '../app/components/adr-timeline-entry';
import { adrActivityLabel, mergedTimeline, timelineByItemId, timelineKey } from '../app/lib/work-timeline';
import { buildWorkListView } from '../app/lib/work-list-view';
import { buildWorkstreamView, filterWorkstreamDirectory } from '../app/lib/workstream-view';
import { buildAssessmentInput } from '../app/shared/work-assessment';
import { commandSchema, emptyItem, snapshotSchema, type AdrActivity, type Snapshot, type Update } from '../app/shared/work';

const at = '2026-10-13T12:00:00.000Z';
const activity = (patch: Partial<AdrActivity> = {}): AdrActivity => ({ id: 'history', adrId: 'adr', itemId: 'task', authorId: 'actor', action: 'adr.create', decision: 'Original historical decision', comment: null, approvalMode: null, revision: 1, createdAt: at, ...patch });
const note: Update = { id: 'note', itemId: 'other', authorId: 'actor', kind: 'note', body: 'Ordinary note', assigneeIds: ['actor'], mentionedPersonIds: ['actor'], createdAt: '2026-10-12T12:00:00.000Z' };
function fixture(): Snapshot {
  return { revision: 1, demo: false, people: [{ id: 'actor', name: 'Historical actor', email: '', role: 'admin' }], goals: [], tags: [], changes: [], starredItemIds: [],
    workstreams: ['a', 'b'].map(id => ({ id, title: id, description: '', leadId: null, goalIds: [] })),
    items: ['task', 'child', 'other'].map((id, i) => ({ ...emptyItem(i === 2 ? 'b' : 'a'), id, title: id, parentId: i === 1 ? 'task' : null, status: 'doing', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: at })),
    updates: [note], adrActivities: [activity()] };
}

test('historic ADRs merge without mutating or replacing ordinary updates, with optional snapshot compatibility', () => {
  const snapshot = fixture();
  const before = structuredClone(snapshot);
  const result = mergedTimeline(snapshot);
  assert.equal(result.length, 2);
  assert.equal(result[0].body, 'Original historical decision');
  assert.equal(result[1], note);
  assert.deepEqual(snapshot, before);
  const { adrActivities, ...legacy } = snapshot;
  assert.equal(snapshotSchema.parse(legacy).adrActivities, undefined);
  assert.deepEqual(mergedTimeline(legacy), [note]);
  assert.deepEqual(buildAssessmentInput(snapshot, 'task', '2026-10-13'), buildAssessmentInput(legacy, 'task', '2026-10-13'));
  assert.equal(commandSchema.safeParse({ type: 'update.add', itemId: 'task', kind: 'adr', body: 'not an ordinary update' }).success, false);
  assert.equal(commandSchema.safeParse({ type: 'update.add', itemId: 'task', kind: 'note', body: 'Ordinary note' }).success, true);
});

test('same-time history has deterministic revision/source/id ties and collision-safe keys', () => {
  const snapshot = fixture();
  snapshot.adrActivities = [activity({ id: 'z', revision: 1 }), activity({ id: 'a', revision: 2 }), activity({ id: 'note', adrId: 'other-adr', revision: 3 })];
  snapshot.updates = [{ ...note, createdAt: at }];
  const keys = mergedTimeline(snapshot).map(timelineKey);
  assert.deepEqual(keys, ['update:note', 'adr:note', 'adr:a', 'adr:z']);
  assert.deepEqual(mergedTimeline({ updates: [...snapshot.updates].reverse(), adrActivities: [...snapshot.adrActivities].reverse() }).map(timelineKey), keys);
  assert.equal(new Set(keys).size, 4);
});

test('all ADR actions render original content, actor/time and source action without edit/delete controls', () => {
  const expected: [AdrActivity['action'], string][] = [
    ['adr.create', 'ADR created'], ['adr.update', 'ADR edited'], ['adr.submit', 'ADR approval requested'],
    ['adr.approve', 'ADR approved (verified)'], ['adr.record_approval', 'ADR approval recorded (not verified)'], ['adr.request_changes', 'ADR changes requested'],
  ];
  for (const [action, label] of expected) {
    const entry = activity({ action, comment: 'Historical comment' });
    assert.equal(adrActivityLabel(entry), label);
    const html = renderToStaticMarkup(createElement(AdrTimelineContent, { activity: entry, snapshot: fixture(), onOpen: () => {}, scope: 'test' }));
    assert.ok(html.includes(label));
    assert.ok(html.includes('Original historical decision'));
    assert.ok(html.includes('Historical comment'));
    assert.ok(html.includes('Historical actor'));
    assert.ok(html.includes(`dateTime="${at}"`));
    assert.ok(html.includes('Open ADR'));
    assert.ok(html.includes('13 Oct 2026, 12:00 UTC'));
    assert.ok(html.includes('data-adr-focus="test-history-history"'));
    assert.equal((html.match(/<button/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<form|<textarea|>Edit<|>Delete</);
  }
});

test('ADR-only task/subtask activity drives latest history, updated/quiet counts and directory/list sorting', () => {
  const snapshot = fixture();
  snapshot.adrActivities!.push(activity({ id: 'child-event', itemId: 'child', createdAt: '2026-10-13T13:00:00.000Z' }));
  const now = Date.parse('2026-10-14T00:00:00.000Z');
  const view = buildWorkstreamView(snapshot, 7, now);
  assert.deepEqual(view.summaries[0].updated, { tasks: 1, subtasks: 1 });
  assert.deepEqual(view.summaries[0].quiet, { tasks: 0, subtasks: 0 });
  assert.equal(view.historyByItemId.get('task')?.[0].kind, 'adr');
  assert.equal(timelineByItemId(snapshot).get('task')?.length, 1);
  assert.deepEqual(filterWorkstreamDirectory(view, snapshot, { search: '', leadId: '', goalId: '', attention: 'all', sort: 'latest' }).map(row => row.stream.id), ['a', 'b']);
  const list = buildWorkListView(snapshot, new Set(snapshot.items.map(item => item.id)), 'latest_update');
  assert.deepEqual(list.roots.map(item => item.id), ['task', 'other']);
  assert.equal(list.latestByRootId.get('task')?.update.id, 'child-event');
  snapshot.adrActivities = [];
  const without = buildWorkstreamView(snapshot, 7, now);
  assert.deepEqual(without.summaries[0].updated, { tasks: 0, subtasks: 0 });
  assert.deepEqual(without.summaries[0].quiet, { tasks: 1, subtasks: 1 });
  assert.deepEqual(buildWorkListView(snapshot, new Set(['task', 'other']), 'latest_update').roots.map(item => item.id), ['other', 'task']);
});
