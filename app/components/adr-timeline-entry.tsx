import type { AdrActivity, Snapshot } from '../shared/work';
import { adrActivityLabel } from '../lib/work-timeline';
import { Button } from './ui/button';

const dateTime = (value: string): string => `${new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;

/** Immutable historical content: no ordinary-update edit/delete controls. */
export function AdrTimelineContent({ activity, snapshot, onOpen, scope }: { activity: AdrActivity; snapshot: Snapshot; onOpen: (id: string) => void; scope: string }) {
  return <div className="timeline-entry ws-timeline-entry" data-adr-history-id={activity.id}>
    <div className="timeline-entry-meta ws-timeline-byline"><strong>{adrActivityLabel(activity)}</strong><span>{snapshot.people.find(person => person.id === activity.authorId)?.name ?? 'Unknown person'}</span><time dateTime={activity.createdAt}>{dateTime(activity.createdAt)}</time></div>
    <p className="record-description ws-timeline-body">{activity.decision}</p>
    {activity.comment && <p className="record-description ws-timeline-body">{activity.comment}</p>}
    <Button type="button" data-adr-focus={`${scope}-history-${activity.id}`} variant="ghost" size="sm" onClick={() => onOpen(activity.adrId)}>Open ADR</Button>
  </div>;
}
