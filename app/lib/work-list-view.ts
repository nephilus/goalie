import type { Item, Snapshot } from '../shared/work';
import { compareTimelineEntries, mergedTimeline, type TimelineEntry } from './work-timeline';

export type WorkSort = 'current' | 'latest_update' | 'due_date' | 'title';
export type LatestWorkUpdate = { update: TimelineEntry; timestamp: number };
export type WorkListView = {
  roots: Item[];
  visible: Item[];
  contextIds: Set<string>;
  childrenByParentId: Map<string, Item[]>;
  totalChildCounts: Map<string, number>;
  latestByItemId: Map<string, LatestWorkUpdate>;
  latestByRootId: Map<string, LatestWorkUpdate>;
  matchedCount: number;
  workstreamCount: number;
};

function newer(candidate: LatestWorkUpdate, previous: LatestWorkUpdate | undefined): boolean {
  return !previous || compareTimelineEntries(candidate.update, previous.update) < 0;
}

export function buildWorkListView(snapshot: Snapshot, matchingIds: ReadonlySet<string>, sort: WorkSort): WorkListView {
  const contextIds = new Set<string>();
  const totalChildCounts = new Map<string, number>();
  let matchedCount = 0;
  for (const item of snapshot.items) {
    if (item.parentId) totalChildCounts.set(item.parentId, (totalChildCounts.get(item.parentId) ?? 0) + 1);
    if (matchingIds.has(item.id)) {
      matchedCount += 1;
      if (item.parentId) contextIds.add(item.parentId);
    }
  }
  const visible: Item[] = [];
  const childrenByParentId = new Map<string, Item[]>();
  const rootsByStream = new Map<string, Item[]>();
  for (const item of snapshot.items) {
    if (!matchingIds.has(item.id) && !contextIds.has(item.id)) continue;
    visible.push(item);
    const groups = item.parentId ? childrenByParentId : rootsByStream;
    const key = item.parentId ?? item.workstreamId;
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  const roots: Item[] = [];
  for (const stream of snapshot.workstreams) {
    const group = rootsByStream.get(stream.id);
    if (group) roots.push(...group);
  }
  const latestByItemId = new Map<string, LatestWorkUpdate>();
  for (const update of mergedTimeline(snapshot)) {
    const candidate = { update, timestamp: Date.parse(update.createdAt) };
    if (newer(candidate, latestByItemId.get(update.itemId))) latestByItemId.set(update.itemId, candidate);
  }
  const latestByRootId = new Map<string, LatestWorkUpdate>();
  for (const root of roots) {
    let latest = latestByItemId.get(root.id);
    for (const child of childrenByParentId.get(root.id) ?? []) {
      const candidate = latestByItemId.get(child.id);
      if (candidate && newer(candidate, latest)) latest = candidate;
    }
    if (latest) latestByRootId.set(root.id, latest);
  }
  if (sort !== 'current') {
    const titles = new Map(visible.map(item => [item.id, item.title.toLowerCase()]));
    const compareTitle = (a: Item, b: Item) => {
      const first = titles.get(a.id)!;
      const second = titles.get(b.id)!;
      return first < second ? -1 : first > second ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    };
    const compare = (latest: ReadonlyMap<string, LatestWorkUpdate>) => (a: Item, b: Item): number => {
      if (sort === 'latest_update') {
        const first = latest.get(a.id)?.timestamp;
        const second = latest.get(b.id)?.timestamp;
        if (first !== second) return first === undefined ? 1 : second === undefined ? -1 : second - first;
      } else if (sort === 'due_date' && a.dueDate !== b.dueDate) {
        return a.dueDate === null ? 1 : b.dueDate === null ? -1 : a.dueDate < b.dueDate ? -1 : 1;
      }
      return compareTitle(a, b);
    };
    roots.sort(compare(latestByRootId));
    const compareChildren = compare(latestByItemId);
    for (const children of childrenByParentId.values()) children.sort(compareChildren);
  }
  return { roots, visible, contextIds, childrenByParentId, totalChildCounts, latestByItemId, latestByRootId, matchedCount, workstreamCount: rootsByStream.size };
}
