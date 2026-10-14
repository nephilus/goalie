import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Activity, ArrowLeft, ArrowRight, CircleAlert, Clock3, Plus } from 'lucide-react';
import type { Item, Snapshot, Workstream } from '../shared/work';
import { timelineKey, type TimelineEntry as WorkTimelineEntry } from '../lib/work-timeline';
import { AdrTimelineActivity } from './adr-timeline-activity';
import { DEFAULT_WORK_FILTERS, matchesBaseWorkFilters } from '../shared/work-filters';
import type { UseWorkAssessmentsResult } from '../lib/use-work-assessments';
import { buildWorkListView, type WorkSort } from '../lib/work-list-view';
import { displayMatchingIds } from '../lib/work-display';
import { buildWorkstreamView, countItems, filterWorkstreamDirectory, retainAttentionIds, type DirectoryFilters, type ItemCounts, type ReviewWindow, type WorkstreamSummary, type WorkstreamView } from '../lib/workstream-view';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import '../workstream.css';

export type WorkstreamWorkspaceProps = {
  compact?: boolean;
  snapshot: Snapshot;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  canEdit: boolean;
  onEditStream: (stream: Workstream, opener?: HTMLElement | null) => void;
  onAddTask: (stream: Workstream, opener?: HTMLElement | null) => void;
  onAddSubtask?: (item: Item, opener?: HTMLElement | null) => void;
  onEditItem: (item: Item, opener?: HTMLElement | null) => void;
  onUpdates: (item: Item, inspect?: boolean, opener?: HTMLElement | null) => void;
  assessment: UseWorkAssessmentsResult;
  aiAvailable: boolean;
  resetKey: number;
  directory?: DirectoryFilters;
  onDirectoryChange?: (next: DirectoryFilters) => void;
};
const initialDirectory: DirectoryFilters = { search: '', leadId: '', goalId: '', attention: 'all', sort: 'name' };
const statuses: Record<Item['status'], string> = { todo: 'To do', doing: 'In progress', done: 'Done' };
const dateTime = (value: string) => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value)) + ' UTC'
  : 'Date unavailable';
const personName = (snapshot: Snapshot, id: string | null) => id ? snapshot.people.find(person => person.id === id)?.name ?? 'Unknown person' : 'No lead';

function Choice({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) {
  return <label className="ws-choice"><span>{label}</span><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label}><SelectValue /></SelectTrigger><SelectContent className="ws-select-content">{options.map(option => <SelectItem value={option.value} key={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>;
}
function Counts({ counts }: { counts: ItemCounts }) {
  return <span className="ws-counts">{counts.tasks} {counts.tasks === 1 ? 'task' : 'tasks'} <span aria-hidden="true">·</span> {counts.subtasks} {counts.subtasks === 1 ? 'subtask' : 'subtasks'}</span>;
}
const metricIcons = { updated: Activity, quiet: Clock3, blocked: CircleAlert };
function MetricIcon({ metric }: { metric: keyof typeof metricIcons }) {
  const Icon = metricIcons[metric];
  return <Icon className="ws-metric-icon" aria-hidden="true" />;
}
function Metrics({ summary, clockReady }: { summary: WorkstreamSummary; clockReady: boolean }) {
  return <dl className="ws-metrics">{(['updated', 'quiet', 'blocked'] as const).map(metric => <div key={metric}><dt className={`ws-metric-${metric}${countItems(summary[metric]) === 0 ? ' ws-metric-zero' : ''}`}><MetricIcon metric={metric} />{metric === 'updated' ? 'Updated' : metric === 'quiet' ? 'Quiet' : 'Blocked'}</dt><dd>{clockReady || metric === 'blocked' ? <Counts counts={summary[metric]} /> : <span className="ws-muted">Calculating…</span>}</dd></div>)}</dl>;
}
function StreamMeta({ stream, snapshot }: { stream: Workstream; snapshot: Snapshot }) {
  const goals = stream.goalIds.map(id => snapshot.goals.find(goal => goal.id === id)?.title ?? 'Unknown goal');
  return <p className="ws-meta"><span>Lead: {personName(snapshot, stream.leadId)}</span><span>{goals.length ? `Goals: ${goals.join(', ')}` : 'No linked goals'}</span></p>;
}

export function WorkstreamWorkspace(props: WorkstreamWorkspaceProps) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const workspaceClass = `ws-workspace${props.compact ? ' ws-compact' : ''}`;
  const [days, setDays] = useState<ReviewWindow>(7);
  const [now, setNow] = useState<number | null>(null);
  const [localDirectory, setLocalDirectory] = useState<DirectoryFilters>(initialDirectory);
  const directory = props.directory ?? localDirectory;
  function setDirectory(next: DirectoryFilters | ((previous: DirectoryFilters) => DirectoryFilters)) {
    const value = typeof next === 'function' ? next(directory) : next;
    setLocalDirectory(value);
    props.onDirectoryChange?.(value);
  }
  const directorySearch = useRef<HTMLInputElement>(null);
  const filtersTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!props.compact) setFiltersOpen(false);
  }, [props.compact]);
  const decisionAvailable = props.aiAvailable && props.assessment.enabled;
  useEffect(() => {
    if (!decisionAvailable && directory.attention === 'decision') setDirectory({ ...directory, attention: 'all' });
  }, [decisionAvailable, directory.attention]);
  function clearDirectory() { setDirectory(initialDirectory); directorySearch.current?.focus(); }
  // Both server render and first client render use null. Never read the clock in render.
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [props.snapshot.revision, props.resetKey, props.selectedId, days]);
  const view = useMemo(() => buildWorkstreamView(props.snapshot, days, now,
    props.aiAvailable && props.assessment.enabled ? props.assessment : undefined), [props.snapshot, days, now, props.aiAvailable, props.assessment]);
  const selected = view.summaries.find(summary => summary.stream.id === props.selectedId);
  const windowControl = <Choice label="Activity window" value={String(days)} onChange={value => setDays(Number(value) as ReviewWindow)} options={[7, 14, 30].map(value => ({ value: String(value), label: `Last ${value} days` }))} />;
  const setFilter = <K extends keyof DirectoryFilters>(key: K, value: DirectoryFilters[K]) => setDirectory(previous => ({ ...previous, [key]: value }));
  const breadcrumb = (title: string) => <h1 id="page-title" className="ws-compact-title"><button type="button" onClick={() => props.onSelect(null)}>Workstreams</button><span aria-hidden="true">/</span><span aria-current="page">{title}</span></h1>;
  if (props.selectedId !== null) {
    if (!selected) return <section className={workspaceClass}>{props.compact ? breadcrumb('Workstream not found') : <Button variant="ghost" onClick={() => props.onSelect(null)}><ArrowLeft />Workstreams</Button>}<div className="ws-empty">{!props.compact && <h2>Workstream not found</h2>}<p>It may have been removed. Return to the directory to choose another workstream.</p></div></section>;
    return <section className={workspaceClass}>{!props.compact && <Button variant="ghost" className="ws-back" onClick={() => props.onSelect(null)}><ArrowLeft />Workstreams</Button>}
      <header className="ws-heading"><div>{props.compact ? breadcrumb(selected.stream.title) : <h2>{selected.stream.title}</h2>}<StreamMeta stream={selected.stream} snapshot={props.snapshot} /></div><div className="ws-actions">{props.canEdit && <><Button variant="outline" onClick={event => props.onEditStream(selected.stream, event.currentTarget)}>Edit workstream</Button><Button onClick={event => props.onAddTask(selected.stream, event.currentTarget)}><Plus />Add task</Button></>}</div></header>
      {selected.stream.description && <p className="ws-description">{selected.stream.description}</p>}
      <div className="ws-overview"><div><Counts counts={selected.total} /><Metrics summary={selected} clockReady={now !== null} /></div>{windowControl}</div>
      <Review key={selected.stream.id} {...props} summary={selected} view={view} days={days} clockReady={now !== null} />
    </section>;
  }
  const effectiveDirectory = !decisionAvailable && directory.attention === 'decision' ? { ...directory, attention: 'all' as const } : directory;
  const visible = filterWorkstreamDirectory(view, props.snapshot, effectiveDirectory);
  const activeFilterCount = Number(Boolean(directory.leadId)) + Number(Boolean(directory.goalId)) + Number(effectiveDirectory.attention !== 'all');
  const filterChoices = <>
      <Choice label="Workstream lead" value={directory.leadId || 'all'} onChange={value => setFilter('leadId', value === 'all' ? '' : value)} options={[{ value: 'all', label: 'All leads' }, ...props.snapshot.people.map(person => ({ value: person.id, label: person.name }))]} />
      <Choice label="Linked goal" value={directory.goalId || 'all'} onChange={value => setFilter('goalId', value === 'all' ? '' : value)} options={[{ value: 'all', label: 'All goals' }, ...props.snapshot.goals.map(goal => ({ value: goal.id, label: goal.title }))]} />
      <Choice label="Workstream attention" value={effectiveDirectory.attention} onChange={value => setFilter('attention', value as DirectoryFilters['attention'])} options={[{ value: 'all', label: 'Any attention' }, { value: 'attention', label: 'Needs attention' }, { value: 'blocked', label: 'Blocked' }, { value: 'quiet', label: 'Quiet' }, ...(decisionAvailable ? [{ value: 'decision', label: 'Jev decision needed' }] : [])]} />
      <Choice label="Sort workstreams" value={directory.sort} onChange={value => setFilter('sort', value as DirectoryFilters['sort'])} options={[{ value: 'name', label: 'Name' }, { value: 'latest', label: 'Latest timeline' }, { value: 'quiet', label: 'Quiet count' }]} />
    </>;
  return <section className={workspaceClass} aria-label="Workstream directory">
    {!props.compact && <header className="ws-heading ws-directory-heading">{windowControl}</header>}
    <div className={props.compact ? 'ws-compact-toolbar' : 'ws-directory-filters'}><label className="ws-choice ws-search"><span>Search workstreams</span><Input ref={directorySearch} aria-label="Search workstreams" placeholder="Search title or description" value={directory.search} maxLength={200} onChange={event => setFilter('search', event.target.value)} /></label>
      {props.compact ? <>{windowControl}<Dialog open={filtersOpen} onOpenChange={setFiltersOpen}><DialogTrigger asChild><Button ref={filtersTrigger} variant="outline">Filters ({activeFilterCount})</Button></DialogTrigger><DialogContent className="ws-filter-dialog" aria-describedby={undefined} onCloseAutoFocus={event => { event.preventDefault(); (filtersTrigger.current?.isConnected ? filtersTrigger.current : directorySearch.current)?.focus(); }}><DialogTitle>Workstream filters</DialogTitle><div className="ws-filter-dialog-fields">{filterChoices}</div><div className="ws-filter-dialog-actions"><Button variant="ghost" onClick={() => setDirectory(initialDirectory)}>Clear filters</Button><Button onClick={() => setFiltersOpen(false)}>Done</Button></div></DialogContent></Dialog></> : filterChoices}
    </div>
    <div className="ws-directory-tools">{directory.search && <Button variant="ghost" onClick={() => { setFilter('search', ''); directorySearch.current?.focus(); }}>Clear search</Button>}{(directory.search || directory.leadId || directory.goalId || directory.attention !== 'all' || (props.compact && directory.sort !== 'name')) && <Button variant="ghost" onClick={clearDirectory}>Clear filters</Button>}</div>
    <p className="ws-muted" role="status">{visible.length} of {props.snapshot.workstreams.length} workstreams</p>
    <div className="ws-directory">{visible.map(summary => <article key={summary.stream.id} className="ws-stream-row"><div className="ws-stream-copy"><h3><button type="button" onClick={() => props.onSelect(summary.stream.id)} aria-label={`Review ${summary.stream.title}`}>{summary.stream.title}<ArrowRight aria-hidden="true" /></button></h3>{summary.stream.description && <p className="ws-stream-description">{summary.stream.description}</p>}<StreamMeta stream={summary.stream} snapshot={props.snapshot} /><Counts counts={summary.total} /></div><Metrics summary={summary} clockReady={now !== null} /></article>)}</div>
    {!visible.length && <div className="ws-empty"><h3>{props.snapshot.workstreams.length ? 'No matching workstreams' : 'No workstreams yet'}</h3><p>{props.snapshot.workstreams.length ? 'Try another search or clear the filters.' : props.canEdit ? 'Create a workstream to group related tasks and begin reviewing work.' : 'Workstreams will appear here when one is created.'}</p>{props.snapshot.workstreams.length > 0 && <Button variant="outline" onClick={clearDirectory}>Clear filters</Button>}</div>}
  </section>;
}

type ReviewProps = WorkstreamWorkspaceProps & { summary: WorkstreamSummary; view: WorkstreamView; days: ReviewWindow; clockReady: boolean };
function Review(props: ReviewProps) {
  const [mode, setMode] = useState<'attention' | 'all'>('attention');
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState<WorkSort>('latest_update');
  const [hideCompleted, setHideCompleted] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const checkboxId = useId();
  const taskSearch = useRef<HTMLInputElement>(null);
  const streamId = props.summary.stream.id;
  const matching = new Set(props.snapshot.items.filter(item => item.workstreamId === streamId && matchesBaseWorkFilters(item, props.snapshot,
    { ...DEFAULT_WORK_FILTERS, search, statuses: status === 'all' ? [] : [status as Item['status']] }, 'all', '', null)).map(item => item.id));
  const displayIds = displayMatchingIds(props.snapshot.items, matching, hideCompleted);
  const key = JSON.stringify([streamId, props.resetKey, props.days, mode, search, status, sort, hideCompleted, refresh]);
  return <div className="ws-review">
    <div className="ws-mode-bar"><div className="ws-modes" role="group" aria-label="Workstream task view"><Button variant={mode === 'attention' ? 'secondary' : 'ghost'} aria-pressed={mode === 'attention'} onClick={() => setMode('attention')}>Attention{props.clockReady ? ` (${countItems(props.summary.attention)})` : ''}</Button><Button variant={mode === 'all' ? 'secondary' : 'ghost'} aria-pressed={mode === 'all'} onClick={() => setMode('all')}>All tasks</Button></div>{mode === 'attention' && <Button variant="ghost" onClick={() => setRefresh(value => value + 1)}>Refresh attention list</Button>}</div>
    <div className="ws-task-filters"><label className="ws-choice ws-search"><span>Search tasks</span><Input ref={taskSearch} aria-label="Search tasks" placeholder="Search tasks and subtasks" maxLength={200} value={search} onChange={event => setSearch(event.target.value)} /></label><Choice label="Task status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All statuses' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))]} /><Choice label="Sort tasks" value={sort} onChange={value => setSort(value as WorkSort)} options={[{ value: 'latest_update', label: 'Latest timeline' }, { value: 'title', label: 'Title' }, { value: 'due_date', label: 'Due date' }, { value: 'current', label: 'Current order' }]} /><label htmlFor={checkboxId} className="ws-hide-completed"><Checkbox id={checkboxId} checked={hideCompleted} onCheckedChange={value => setHideCompleted(value === true)} />Hide completed</label></div>
    {search && <Button variant="ghost" onClick={() => { setSearch(''); taskSearch.current?.focus(); }}>Clear search</Button>}
    <AssessmentNotice {...props} />
    <ReviewRows key={key} {...props} mode={mode} displayIds={displayIds} sort={sort} onShowAll={() => setMode('all')} />
  </div>;
}

function AssessmentNotice({ assessment, aiAvailable, snapshot, summary }: ReviewProps) {
  const items = snapshot.items.filter(item => item.workstreamId === summary.stream.id && item.status !== 'done');
  const scoped = items.filter(item => assessment.scopeItemIds.has(item.id));
  if (!aiAvailable || !assessment.enabled) return null;
  let message: string;
  if (assessment.pausedError || scoped.some(item => assessment.errorsByItemId.has(item.id))) message = 'Jev could not finish checking some tasks. Decision signals may be incomplete. Use the Goalie Suggestions controls to retry.';
  else if (assessment.loading || scoped.some(item => assessment.pendingIds.has(item.id))) message = 'Jev is checking tasks. Decision signals may be incomplete while checks are pending.';
  else if (assessment.locallyStopped) message = 'Jev checks are paused. Decision signals may be incomplete.';
  else if (!scoped.length) message = 'No active tasks here are in Jev’s saved scope. Attention still includes saved blockers and quiet work.';
  else if (scoped.some(item => assessment.refreshRequiredIds.has(item.id) || assessment.entriesByItemId.get(item.id)?.state !== 'current')) message = 'Some Jev decision checks are missing or need refreshing. Attention is not a complete assessment of this workstream.';
  else message = 'Jev decision signals cover only tasks in its saved scope. No decision signal does not mean no decision is needed.';
  return <p className="ws-assessment-note" role="status">{message}</p>;
}

function ReviewRows(props: ReviewProps & { mode: 'attention' | 'all'; displayIds: Set<string>; sort: WorkSort; onShowAll: () => void }) {
  const [retained, setRetained] = useState<Set<string>>(() => new Set());
  const current = new Set([...props.displayIds].filter(id => props.view.reasonsByItemId.get(id)?.length));
  const visible = props.mode === 'attention' ? new Set([...retainAttentionIds(props.snapshot, props.summary.stream.id, retained, current)].filter(id => props.displayIds.has(id))) : props.displayIds;
  // Commit only entries the user actually saw. A keyed remount resets retention on explicit view changes.
  useEffect(() => {
    if (props.mode !== 'attention') return;
    setRetained(previous => previous.size === visible.size && [...previous].every(id => visible.has(id)) ? previous : visible);
  }, [props.mode, visible]);
  const list = buildWorkListView(props.snapshot, visible, props.sort);
  const rows = props.mode === 'attention' ? [...list.roots.flatMap(root => [root, ...(list.childrenByParentId.get(root.id) ?? [])])].filter(item => visible.has(item.id)) : list.roots;
  if (!visible.size) return <div className="ws-empty"><h3>{props.mode === 'attention' ? 'No flagged tasks in this view' : 'No tasks in this view'}</h3><p>{props.mode === 'attention' ? 'No saved blocker, quiet item, or current Jev decision signal matches these filters. This is not a guarantee that no attention is needed.' : 'Try another search, change the status filter, or show completed work.'}</p>{props.mode === 'attention' && <Button variant="outline" onClick={props.onShowAll}>View all tasks</Button>}{countItems(props.summary.total) === 0 && props.canEdit && <Button variant="outline" onClick={event => props.onAddTask(props.summary.stream, event.currentTarget)}><Plus />Add the first task</Button>}</div>;
  return <div className="ws-task-list" aria-label={props.mode === 'attention' ? 'Attention tasks' : 'All tasks'}>{rows.map(item => <div className="ws-task-group" key={item.id}><TaskRow {...props} item={item} context={props.mode === 'all' && !visible.has(item.id)} retained={props.mode === 'attention' && !(props.view.reasonsByItemId.get(item.id)?.length)} />{props.mode === 'all' && <div className="ws-subtasks">{(list.childrenByParentId.get(item.id) ?? []).map(child => <TaskRow key={child.id} {...props} item={child} context={false} retained={false} />)}</div>}</div>)}</div>;
}

function TimelineEntry({ update, snapshot }: { update: WorkTimelineEntry; snapshot: Snapshot }) {
  if (update.kind === 'adr') return <AdrTimelineActivity activity={update} snapshot={snapshot} scope="workstream" />;
  return <div className="ws-timeline-entry"><p className="ws-timeline-byline">{personName(snapshot, update.authorId)} <span aria-hidden="true">·</span> <time dateTime={update.createdAt}>{dateTime(update.createdAt)}</time>{update.kind !== 'note' && <span>{update.kind === 'blocker' ? 'Blocker reported' : 'Blocker resolved'}</span>}</p><p className="ws-timeline-body">{update.body}</p></div>;
}
function TaskRow(props: ReviewProps & { item: Item; context: boolean; retained: boolean; mode: 'attention' | 'all' }) {
  const { item, snapshot, assessment } = props;
  const [historyLimit, setHistoryLimit] = useState(10);
  const history = props.view.historyByItemId.get(item.id) ?? [];
  const reasons = props.view.reasonsByItemId.get(item.id) ?? [];
  const parent = item.parentId ? snapshot.items.find(candidate => candidate.id === item.parentId) : null;
  const error = assessment.errorsByItemId.get(item.id);
  return <article className={`ws-task-row${props.retained ? ' ws-retained' : ''}`} aria-label={`${item.parentId ? 'Subtask' : 'Task'}: ${item.title}`}>
    {props.mode === 'attention' && parent && <p className="ws-breadcrumb">Task: {parent.title} <span aria-hidden="true">/</span> Subtask</p>}
    <div className="ws-task-heading"><h3>{props.canEdit ? <button type="button" className="ws-task-title" onClick={event => props.onEditItem(item, event.currentTarget)}>{item.title}</button> : item.title}</h3><span className="ws-status">{statuses[item.status]}</span></div>
    <p className="ws-task-meta">{item.assigneeIds.length ? item.assigneeIds.map(id => personName(snapshot, id)).join(', ') : 'Unassigned'}{item.dueDate && <span>Due {item.dueDate}</span>}{props.context && <span>Parent context, outside current filters</span>}</p>
    {reasons.length > 0 && <div className="ws-reasons">{reasons.map(reason => reason === 'decision' ? <Button key={reason} variant="outline" size="sm" onClick={event => props.onUpdates(item, true, event.currentTarget)}>Jev: decision needed</Button> : <span key={reason} className={`ws-reason ws-reason-${reason}`}><MetricIcon metric={reason} />{reason === 'blocked' ? 'Blocked' : `Quiet for over ${props.days} days`}</span>)}</div>}
    {props.retained && <p className="ws-retained-note">No longer flagged. Kept here until you refresh the attention list or change this view.</p>}
    {item.blocker.trim() && item.status !== 'done' && <p className="ws-blocker"><strong>Blocker:</strong> {item.blocker}</p>}
    {props.aiAvailable && assessment.enabled && assessment.scopeItemIds.has(item.id) && item.status !== 'done' && <>{error ? <p className="ws-ai-error">Jev check failed: {error.message} {props.canEdit && <Button variant="ghost" size="sm" onClick={() => assessment.retryItem(item.id)}>Retry Jev check</Button>}</p> : assessment.pendingIds.has(item.id) ? <p className="ws-muted">Jev check pending. Decision signal not yet available.</p> : (assessment.refreshRequiredIds.has(item.id) || assessment.entriesByItemId.get(item.id)?.state !== 'current') && <p className="ws-muted">Jev decision check needs refreshing.</p>}</>}
    {history[0] ? <div className="ws-latest"><span className="ws-latest-label">Latest timeline entry</span><TimelineEntry update={history[0]} snapshot={snapshot} /></div> : <p className="ws-no-history">No timeline entries yet. Created <time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time>.</p>}
    <div className="ws-task-footer">{props.canEdit && props.onAddSubtask && !item.parentId && item.status !== 'done' && <Button variant="ghost" size="sm" onClick={event => props.onAddSubtask?.(item, event.currentTarget)}>Add subtask</Button>}{props.canEdit && <Button variant="outline" size="sm" onClick={event => props.onUpdates(item, false, event.currentTarget)}><Plus />Add update</Button>}{!props.canEdit && <Button variant="ghost" size="sm" onClick={event => props.onUpdates(item, false, event.currentTarget)}>View updates</Button>}</div>
    {history.length > 1 && <details className="ws-history"><summary>Show more history ({history.length - 1})</summary><div className="ws-history-entries">{history.slice(1, historyLimit + 1).map(update => <TimelineEntry key={timelineKey(update)} update={update} snapshot={snapshot} />)}{history.length > historyLimit + 1 && <Button variant="outline" onClick={() => setHistoryLimit(limit => limit + 10)}>Show 10 older entries</Button>}</div></details>}
  </article>;
}
