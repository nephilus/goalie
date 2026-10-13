import type { AdrActivity, Snapshot, Update } from '../shared/work';

export type AdrTimelineEntry = AdrActivity & { kind: 'adr'; body: string };
export type TimelineEntry = Update | AdrTimelineEntry;

export function adrActivityLabel(activity: AdrActivity): string {
  switch (activity.action) {
    case 'adr.create': return 'ADR created';
    case 'adr.update': return 'ADR edited';
    case 'adr.submit': return 'ADR approval requested';
    case 'adr.approve': return 'ADR approved (verified)';
    case 'adr.record_approval': return 'ADR approval recorded (not verified)';
    case 'adr.request_changes': return 'ADR changes requested';
  }
}

export const timelineKey = (entry: TimelineEntry): string => `${entry.kind === 'adr' ? 'adr' : 'update'}:${entry.id}`;

/** Newest first, with stable tie ordering independent of query/input order. */
export function compareTimelineEntries(a: TimelineEntry, b: TimelineEntry): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
    (a.kind === 'adr' && b.kind === 'adr' ? b.revision - a.revision : 0) ||
    (timelineKey(a) < timelineKey(b) ? 1 : timelineKey(a) > timelineKey(b) ? -1 : 0);
}

/** Presentation only. Never feed these entries back into update commands or AI inputs. */
export function mergedTimeline(snapshot: Pick<Snapshot, 'updates' | 'adrActivities'>): TimelineEntry[] {
  return [...snapshot.updates, ...(snapshot.adrActivities ?? []).map(activity => ({ ...activity, kind: 'adr' as const, body: activity.decision }))].sort(compareTimelineEntries);
}

export function timelineByItemId(snapshot: Pick<Snapshot, 'updates' | 'adrActivities'>): Map<string, TimelineEntry[]> {
  const result = new Map<string, TimelineEntry[]>();
  for (const entry of mergedTimeline(snapshot)) {
    const entries = result.get(entry.itemId) ?? [];
    entries.push(entry);
    result.set(entry.itemId, entries);
  }
  return result;
}
