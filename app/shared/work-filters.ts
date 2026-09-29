import { z } from 'zod';
import type { Item, Snapshot } from './work';

export type WorkScope = 'all' | 'mine';
export type DueTiming = '' | 'overdue' | 'due_soon' | 'overdue_or_due_soon' | 'later' | 'undated';

const filterText = z.string().max(200);
const filterId = z.string().min(1).max(100);
const uniqueIds = z.array(filterId).refine(values => new Set(values).size === values.length, 'Duplicate IDs are not allowed');
const uniqueStatuses = z.array(z.enum(['todo', 'doing', 'done'])).refine(values => new Set(values).size === values.length, 'Duplicate statuses are not allowed');

export const workFiltersSchema = z.object({
 search: filterText,
 workstreamIds: uniqueIds,
 goalIds: uniqueIds,
 assigneeIds: uniqueIds,
 statuses: uniqueStatuses,
 tagIds: uniqueIds,
 starredOnly: z.boolean(),
 dueTiming: z.enum(['', 'overdue', 'due_soon', 'overdue_or_due_soon', 'later', 'undated']),
}).strict();
export type WorkFilters = z.infer<typeof workFiltersSchema>;

export const DEFAULT_WORK_FILTERS: WorkFilters = {
 search: '',
 workstreamIds: [],
 goalIds: [],
 assigneeIds: [],
 statuses: [],
 tagIds: [],
 starredOnly: false,
 dueTiming: '',
};

export const workScopeSchema = z.enum(['all', 'mine']);

function isValidCalendarDate(value: string): boolean {
 if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
 const date = new Date(`${value}T00:00:00.000Z`);
 return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function calendarDay(value: string): number {
 return Date.parse(`${value}T00:00:00.000Z`) / 86_400_000;
}

/** Signed whole UTC calendar days from asOf to date. */
export function calendarDaysBetween(asOf: string, date: string): number {
 if (!isValidCalendarDate(asOf) || !isValidCalendarDate(date)) throw new Error('Invalid UTC calendar date');
 return calendarDay(date) - calendarDay(asOf);
}

function personName(snapshot: Snapshot, id: string): string {
 return snapshot.people.find(person => person.id === id)?.name ?? 'Unknown person';
}

function peopleNames(snapshot: Snapshot, ids: string[]): string {
 return ids.map(id => personName(snapshot, id)).join(', ') || 'Unassigned';
}

/**
 * The ordinary work-view predicate. Keep this as the sole implementation used
 * by both the route and assessment scope enforcement.
 */
export function matchesBaseWorkFilters(
 item: Item,
 snapshot: Snapshot,
 filters: WorkFilters,
 scope: WorkScope,
 userId: string,
 asOf: string | null,
): boolean {
 if (scope === 'mine' && !item.assigneeIds.includes(userId)) return false;
 if (filters.starredOnly && !snapshot.starredItemIds.includes(item.id)) return false;
 if (filters.workstreamIds.length && !filters.workstreamIds.includes(item.workstreamId)) return false;
 const stream = snapshot.workstreams.find(value => value.id === item.workstreamId);
 if (filters.goalIds.length && !filters.goalIds.some(goalId => stream?.goalIds.includes(goalId))) return false;
 if (filters.assigneeIds.length && !filters.assigneeIds.some(assigneeId => item.assigneeIds.includes(assigneeId))) return false;
 if (filters.statuses.length && !filters.statuses.includes(item.status)) return false;
 if (filters.tagIds.length && !filters.tagIds.some(tagId => item.tagIds.includes(tagId))) return false;
 if (filters.dueTiming) {
  if (item.status === 'done' || !asOf) return false;
  if (filters.dueTiming === 'undated') {
   if (item.dueDate !== null) return false;
  } else {
   if (!item.dueDate) return false;
   const days = calendarDaysBetween(asOf, item.dueDate);
   if (filters.dueTiming === 'overdue' && days >= 0) return false;
   if (filters.dueTiming === 'due_soon' && (days < 0 || days > 3)) return false;
   if (filters.dueTiming === 'overdue_or_due_soon' && days > 3) return false;
   if (filters.dueTiming === 'later' && days <= 3) return false;
  }
 }
 const query = filters.search.trim().toLowerCase();
 if (!query) return true;
 const goalTitles = stream?.goalIds.map(id => snapshot.goals.find(goal => goal.id === id)?.title ?? '') ?? [];
 const haystack = [
  item.title,
  item.description,
  item.blocker,
  stream?.title ?? '',
  ...goalTitles,
  peopleNames(snapshot, item.assigneeIds),
  ...item.tagIds.map(id => snapshot.tags.find(tag => tag.id === id)?.name ?? ''),
 ].join(' ').toLowerCase();
 return haystack.includes(query);
}
