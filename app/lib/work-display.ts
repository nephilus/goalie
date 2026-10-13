import type { Item } from '../shared/work';

/** Apply display hiding after real filters. The list builder restores parent context. */
export function displayMatchingIds(items: readonly Item[], matchingIds: ReadonlySet<string>, hideCompleted: boolean): Set<string> {
  return new Set(items.filter(item => matchingIds.has(item.id) && (!hideCompleted || item.status !== 'done')).map(item => item.id));
}

export function statusActions(current: Item['status']): Array<{ status: Item['status']; label: string }> {
  const actions: Array<{ status: Item['status']; label: string }> = [
    { status: 'doing', label: 'Mark in progress' },
    { status: 'done', label: 'Mark done' },
    { status: 'todo', label: 'Move to todo' },
  ];
  return actions.filter(action => action.status !== current);
}
