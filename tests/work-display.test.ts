import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayMatchingIds, statusActions } from '../app/lib/work-display';
import { emptyItem, type Item } from '../app/shared/work';

const item = (id: string, status: Item['status'], parentId: string | null = null): Item => ({
  ...emptyItem('stream'), id, title: id, status, parentId, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

test('display hiding removes completed matches without adding nonmatching work', () => {
  const items = [item('todo', 'todo'), item('doing', 'doing'), item('done', 'done'), item('excluded', 'doing')];
  const matches = new Set(['todo', 'doing', 'done']);
  assert.deepEqual([...displayMatchingIds(items, matches, true)], ['todo', 'doing']);
  assert.deepEqual([...displayMatchingIds(items, matches, false)], ['todo', 'doing', 'done']);
  assert.deepEqual([...matches], ['todo', 'doing', 'done']);
});

test('completed parent is removed as a match while matching unfinished child remains discoverable', () => {
  const items = [item('parent', 'done'), item('child', 'todo', 'parent'), item('sibling', 'done', 'parent')];
  const visible = displayMatchingIds(items, new Set(items.map(value => value.id)), true);
  assert.deepEqual([...visible], ['child']);
  assert.equal(items.find(value => visible.has(value.id))?.parentId, 'parent');
});

test('explicit done filter remains empty while hidden rather than silently changing status semantics', () => {
  const items = [item('unfinished', 'todo'), item('finished', 'done')];
  assert.deepEqual([...displayMatchingIds(items, new Set(['finished']), true)], []);
  assert.deepEqual([...displayMatchingIds(items, new Set(['finished']), false)], ['finished']);
});

for (const current of ['todo', 'doing', 'done'] as const) {
  test(`status actions exclude the current ${current} status`, () => {
    const actions = statusActions(current);
    assert.equal(actions.length, 2);
    assert.equal(actions.some(action => action.status === current), false);
    assert.equal(new Set(actions.map(action => action.status)).size, 2);
  });
}
