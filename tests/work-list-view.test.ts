import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkListView, type WorkSort } from '../app/lib/work-list-view';
import { emptyItem, type Item, type Snapshot, type Update } from '../app/shared/work';

function fixture(): Snapshot {
  const item = (id: string, title: string, workstreamId: string, parentId: string | null = null, dueDate: string | null = null): Item => ({ ...emptyItem(workstreamId), id, title, parentId, dueDate, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-10-05T00:00:00.000Z' });
  const update = (id: string, itemId: string, day: string, kind: Update['kind']): Update => ({ id, itemId, authorId: 'person', body: id, kind, assigneeIds: [], createdAt: `2026-10-${day}T09:00:00.000Z` });
  return {
    revision: 1, demo: false, people: [], goals: [], tags: [], changes: [], starredItemIds: [],
    workstreams: ['a', 'b'].map(id => ({ id, title: id, description: '', leadId: null, goalIds: [] })),
    items: [item('p2', 'Alpha parent', 'b', null, '2026-10-02'), item('p1', 'Zulu parent', 'a', null, '2026-10-04'), item('c2', 'Alpha child', 'a', 'p1', '2026-10-01'), item('c1', 'Child newest', 'a', 'p1', '2026-10-03'), item('p3', 'Undated', 'b')],
    updates: [update('u1', 'p1', '01', 'note'), update('u2', 'p2', '02', 'blocker'), update('u3', 'c1', '03', 'blocker_resolved'), update('hidden', 'c2', '04', 'note')],
  };
}

const sorts: WorkSort[] = ['current', 'latest_update', 'due_date', 'title'];

test('visible matching children promote parent groups across streams, excluding hidden siblings', () => {
  const data = fixture();
  const matching = new Set(['p1', 'p2', 'p3', 'c1']);
  const view = buildWorkListView(data, matching, 'latest_update');
  assert.deepEqual(view.roots.map(item => item.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(view.childrenByParentId.get('p1')?.map(item => item.id), ['c1']);
  assert.equal(view.latestByRootId.get('p1')?.update, data.updates[2]);
  assert.equal(view.totalChildCounts.get('p1'), 2);
  assert.equal(view.matchedCount, 4);
  assert.equal(view.workstreamCount, 2);
  const excluded = buildWorkListView(data, new Set(['p1', 'p2', 'p3']), 'latest_update');
  assert.deepEqual(excluded.roots.map(item => item.id), ['p2', 'p1', 'p3']);
  for (const sort of sorts) {
    const childOnly = buildWorkListView(data, new Set(['c1']), sort);
    assert.deepEqual(childOnly.roots.map(item => item.id), ['p1']);
    assert.deepEqual(childOnly.visible.map(item => item.id), ['p1', 'c1']);
    assert.deepEqual([...childOnly.contextIds], ['p1']);
    assert.equal(childOnly.matchedCount, 1);
    assert.equal(childOnly.workstreamCount, 1);
  }
});

test('current order preserves stream-major snapshot order and other sorts preserve nesting', () => {
  const data = fixture();
  const matching = new Set(data.items.map(item => item.id));
  const expected: Record<WorkSort, string[]> = { current: ['p1', 'p2', 'p3'], latest_update: ['p1', 'p2', 'p3'], due_date: ['p2', 'p1', 'p3'], title: ['p2', 'p3', 'p1'] };
  for (const sort of sorts) {
    const view = buildWorkListView(data, matching, sort);
    assert.deepEqual(view.roots.map(item => item.id), expected[sort]);
    assert.deepEqual(view.childrenByParentId.get('p1')?.map(item => item.id), ['c2', 'c1']);
    assert.equal(view.matchedCount, 5);
  }
  data.items[2].dueDate = '2026-10-05';
  assert.deepEqual(buildWorkListView(data, matching, 'due_date').childrenByParentId.get('p1')?.map(item => item.id), ['c1', 'c2']);
  data.updates[3].createdAt = '2026-10-01T09:00:00.000Z';
  assert.deepEqual(buildWorkListView(data, matching, 'latest_update').childrenByParentId.get('p1')?.map(item => item.id), ['c1', 'c2']);
});

test('post edits and field edits do not bump recency; deletion falls back to surviving history', () => {
  const data = fixture();
  const matching = new Set(['p1', 'p2', 'c1']);
  data.updates[2].body = 'Edited body';
  data.items[1].updatedAt = '2026-12-01T00:00:00.000Z';
  assert.equal(buildWorkListView(data, matching, 'latest_update').latestByRootId.get('p1')?.update.id, 'u3');
  data.updates.splice(2, 1);
  assert.deepEqual(buildWorkListView(data, matching, 'latest_update').roots.map(item => item.id), ['p2', 'p1']);
  assert.equal(buildWorkListView(data, matching, 'latest_update').latestByRootId.get('p1')?.update.id, 'u1');
  data.updates = [];
  assert.deepEqual(buildWorkListView(data, matching, 'latest_update').roots.map(item => item.id), ['p2', 'p1']);
  assert.equal(buildWorkListView(data, matching, 'latest_update').latestByRootId.size, 0);
});

test('post ties choose greater update ID; ranking ties use casefolded title then item ID', () => {
  const data = fixture();
  data.items[0].title = 'SAME';
  data.items[1].title = 'same';
  data.items[0].dueDate = data.items[1].dueDate;
  const first = { ...data.updates[0], id: 'z', createdAt: data.updates[1].createdAt };
  data.updates = [first, data.updates[1], { ...first, id: 'a' }];
  for (const sort of ['latest_update', 'due_date', 'title'] as WorkSort[]) {
    const view = buildWorkListView(data, new Set(['p1', 'p2']), sort);
    assert.deepEqual(view.roots.map(item => item.id), ['p1', 'p2']);
    assert.equal(view.latestByItemId.get('p1')?.update, first);
  }
});

test('frozen snapshot remains unchanged and empty input has no visible work', () => {
  const data = fixture();
  function freeze(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  const before = structuredClone(data);
  freeze(data);
  const matching = new Set(data.items.map(item => item.id));
  for (const sort of sorts) {
    const view = buildWorkListView(data, matching, sort);
    assert.equal(view.roots.find(item => item.id === 'p1'), data.items[1]);
    assert.deepEqual(data, before);
    assert.deepEqual([...matching], data.items.map(item => item.id));
    const empty = buildWorkListView({ ...data, items: [], updates: [], workstreams: [] }, new Set(), sort);
    assert.deepEqual(empty.roots, []);
    assert.deepEqual(empty.visible, []);
    for (const map of [empty.contextIds, empty.childrenByParentId, empty.totalChildCounts, empty.latestByItemId, empty.latestByRootId]) assert.equal(map.size, 0);
    assert.equal(empty.matchedCount, 0);
    assert.equal(empty.workstreamCount, 0);
  }
});
