import type { Item, Snapshot, Workstream } from '../shared/work';
import { timelineByItemId, type TimelineEntry } from './work-timeline';
import type { UseWorkAssessmentsResult } from './use-work-assessments';

export type ReviewWindow = 7 | 14 | 30;
export type AttentionReason = 'blocked' | 'quiet' | 'decision';
export type ItemCounts = { tasks: number; subtasks: number };
export type WorkstreamSummary = {
  stream: Workstream;
  total: ItemCounts;
  updated: ItemCounts;
  quiet: ItemCounts;
  blocked: ItemCounts;
  attention: ItemCounts;
  latestTimelineAt: number | null;
};
export type WorkstreamView = {
  summaries: WorkstreamSummary[];
  historyByItemId: Map<string, TimelineEntry[]>;
  reasonsByItemId: Map<string, AttentionReason[]>;
};
export type DecisionAssessment = Pick<UseWorkAssessmentsResult,
  'entriesByItemId' | 'scopeItemIds' | 'pendingIds' | 'errorsByItemId' | 'refreshRequiredIds'>;
export type DirectoryFilters = {
  search: string;
  leadId: string;
  goalId: string;
  attention: 'all' | 'attention' | 'blocked' | 'quiet' | 'decision';
  sort: 'name' | 'latest' | 'quiet';
};
export const countItems = (counts: ItemCounts): number => counts.tasks + counts.subtasks;
const emptyCounts = (): ItemCounts => ({ tasks: 0, subtasks: 0 });
const increment = (counts: ItemCounts, item: Item) => { counts[item.parentId ? 'subtasks' : 'tasks'] += 1; };

/** Only fresh, in-scope decisions can contribute to Attention. */
export function hasCurrentDecision(itemId: string, assessment?: DecisionAssessment): boolean {
  if (!assessment || !assessment.scopeItemIds.has(itemId) || assessment.pendingIds.has(itemId) ||
    assessment.errorsByItemId.has(itemId) || assessment.refreshRequiredIds.has(itemId)) return false;
  const entry = assessment.entriesByItemId.get(itemId);
  return entry?.state === 'current' && entry.currentInputKey !== null &&
    entry.currentInputKey === entry.assessment?.inputKey && entry.assessment.labels.decision === 'needed';
}

/** Pure snapshot derivation. The caller supplies its clock, including null during SSR. */
export function buildWorkstreamView(snapshot: Snapshot, days: ReviewWindow, now: number | null, assessment?: DecisionAssessment): WorkstreamView {
  const cutoff = now === null ? null : now - days * 86_400_000;
  const historyByItemId = timelineByItemId(snapshot);
  const summaries = snapshot.workstreams.map(stream => ({
    stream, total: emptyCounts(), updated: emptyCounts(), quiet: emptyCounts(),
    blocked: emptyCounts(), attention: emptyCounts(), latestTimelineAt: null as number | null,
  }));
  const byStream = new Map(summaries.map(summary => [summary.stream.id, summary]));
  const reasonsByItemId = new Map<string, AttentionReason[]>();
  for (const item of snapshot.items) {
    const summary = byStream.get(item.workstreamId);
    if (!summary) continue;
    increment(summary.total, item);
    const latest = historyByItemId.get(item.id)?.[0];
    const latestAt = latest ? Date.parse(latest.createdAt) : null;
    if (latestAt !== null && Number.isFinite(latestAt)) {
      summary.latestTimelineAt = Math.max(summary.latestTimelineAt ?? -Infinity, latestAt);
      if (cutoff !== null && now !== null && latestAt >= cutoff && latestAt <= now) increment(summary.updated, item);
    }
    const reasons: AttentionReason[] = [];
    const active = item.status !== 'done';
    if (active && item.blocker.trim()) {
      increment(summary.blocked, item);
      reasons.push('blocked');
    }
    // TODO is deliberately never Quiet, including TODO with an active blocker.
    const lastActivity = latestAt ?? Date.parse(item.createdAt);
    if (item.status === 'doing' && cutoff !== null && Number.isFinite(lastActivity) && lastActivity < cutoff) {
      increment(summary.quiet, item);
      reasons.push('quiet');
    }
    if (active && hasCurrentDecision(item.id, assessment)) reasons.push('decision');
    if (reasons.length) increment(summary.attention, item);
    reasonsByItemId.set(item.id, reasons);
  }
  return { summaries, historyByItemId, reasonsByItemId };
}

export function filterWorkstreamDirectory(view: WorkstreamView, snapshot: Snapshot, filters: DirectoryFilters): WorkstreamSummary[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const decisionStreams = new Set(snapshot.items.filter(item => view.reasonsByItemId.get(item.id)?.includes('decision')).map(item => item.workstreamId));
  return view.summaries.filter(summary => {
    const stream = summary.stream;
    return (!query || `${stream.title}\n${stream.description}`.toLocaleLowerCase().includes(query)) &&
      (!filters.leadId || stream.leadId === filters.leadId) &&
      (!filters.goalId || stream.goalIds.includes(filters.goalId)) &&
      (filters.attention === 'all' || (filters.attention === 'decision' ? decisionStreams.has(stream.id) : countItems(summary[filters.attention]) > 0));
  }).sort((a, b) => {
    const metric = filters.sort === 'latest' ? (b.latestTimelineAt ?? -Infinity) - (a.latestTimelineAt ?? -Infinity) :
      filters.sort === 'quiet' ? countItems(b.quiet) - countItems(a.quiet) : 0;
    return (Number.isNaN(metric) ? 0 : metric) || a.stream.title.localeCompare(b.stream.title) || a.stream.id.localeCompare(b.stream.id);
  });
}

/** Keep already displayed entries stable, but never retain deleted or moved items. */
export function retainAttentionIds(snapshot: Snapshot, streamId: string, previous: ReadonlySet<string>, current: ReadonlySet<string>): Set<string> {
  return new Set(snapshot.items.filter(item => item.workstreamId === streamId && (current.has(item.id) || previous.has(item.id))).map(item => item.id));
}
