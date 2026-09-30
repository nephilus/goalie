import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { redirect, useLoaderData } from 'react-router';
import { CheckCircle2, ChevronDown, CircleAlert, Filter, FolderKanban, ListChecks, LoaderCircle, Mail, Menu, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Sparkles, Star, StickyNote, SunMoon, Tags, Target, Trash2, Users, X } from 'lucide-react';
import type { UseWorkAutofillResult } from '../lib/use-work-autofill';
import { useWorkAssessments, type UseWorkAssessmentsResult } from '../lib/use-work-assessments';
import type { Command, Goal, GoalInput, Item, ItemInput, Person, PersonInput, Snapshot, Tag, TagInput, Workstream, WorkstreamInput } from '../shared/work';
import type { AssessmentScope, DecisionLabel } from '../shared/work-assessment';
import { assessmentModelState } from '../shared/work-assessment';
import { DEFAULT_WORK_FILTERS, matchesBaseWorkFilters, type WorkFilters, type WorkScope } from '../shared/work-filters';
import { assistResultSchema, type AssistField, type AssistResult } from '../shared/work-assist';
import { useWorkAutofill } from '../lib/use-work-autofill';
import { AuthError, requireAuth } from '../server/auth.server';
import { assistStatus } from '../server/work-assist.server';
import { readWork } from '../server/work.server';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '../components/ui/accordion';
import { Badge } from '../components/ui/badge';
import { Checkbox } from '../components/ui/checkbox';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Textarea } from '../components/ui/textarea';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '../components/ui/alert-dialog';
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Alert, AlertDescription } from '../components/ui/alert';

export async function loader({ request }: { request: Request }) {
  try {
    const auth = await requireAuth(request);
    const data = await readWork(auth.person);
    return { data, user: auth.person, csrfToken: auth.csrfToken, assist: assistStatus() };
  } catch (error) {
    if (error instanceof AuthError && error.status === 401) throw redirect(`/auth/login?returnTo=${encodeURIComponent('/')}`);
    throw error;
  }
}

type AppError = Error & { status?: number; code?: string };
type Section = 'work' | 'goals' | 'streams' | 'tags' | 'people';
type Panel = 'item' | 'goal' | 'stream' | 'tag' | 'person' | 'updates' | null;
type ItemKind = '' | 'main' | 'subtask';
type ThemePreference = 'system' | 'light' | 'dark';
type AssistStatus = { enabled: boolean; model: string | null };
function parseAssistStatus(value: unknown): AssistStatus | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as { enabled?: unknown; model?: unknown };
  if (typeof candidate.enabled !== 'boolean' || (candidate.model !== null && typeof candidate.model !== 'string')) return null;
  return { enabled: candidate.enabled, model: candidate.model };
}
type CommandOptions = { closePanel?: boolean; preserveDirty?: boolean; starOnly?: boolean };
type UpdateKind = 'note' | 'blocker' | 'blocker_resolved';
type Filters = WorkFilters & { assessmentDecisions: DecisionLabel[] };
type BadgeFilter = { key: 'statuses'; value: Item['status'] } | { key: 'tagIds' | 'workstreamIds'; value: string } | { key: 'assessmentDecisions'; value: DecisionLabel };
type FilterCategory = 'status' | 'tags' | 'decisions' | 'workstreams' | 'more' | null;
type ItemCreationContext = { workstreamId?: string; parentId?: string };
type StreamCreationContext = { goalId?: string };
type PendingPersonCommand = { command: Command; title: string; description: string };
type PendingDelete = { command: Command; title: string; description: string; entity: 'item' | 'goal' | 'workstream' | 'tag' | 'update' };

const statusLabels: Record<Item['status'], string> = { todo: 'To do', doing: 'In progress', done: 'Done' };
function itemInput(item: Item): ItemInput {
  return { title: item.title, description: item.description, workstreamId: item.workstreamId, parentId: item.parentId, status: item.status, assigneeIds: [...item.assigneeIds], dueDate: item.dueDate, blocker: item.blocker, tagIds: [...item.tagIds] };
}

function emptyItem(workstreamId = ''): ItemInput {
  return { title: '', description: '', workstreamId, parentId: null, status: 'todo', assigneeIds: [], dueDate: null, blocker: '', tagIds: [] };
}
function emptyGoal(): GoalInput { return { title: '', description: '', targetDate: null }; }
function emptyStream(): WorkstreamInput { return { title: '', description: '', leadId: null, goalIds: [] }; }
function emptyTag(): TagInput { return { name: '', description: '', workstreamId: null }; }
function displayDate(value: string | null) { if (!value) return 'No date'; return new Date(`${value}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
function personName(people: Person[], id: string | null) { return people.find(person => person.id === id)?.name ?? 'Unknown person'; }
function peopleNames(people: Person[], ids: string[]) { return ids.map(id => personName(people, id)).join(', ') || 'Unassigned'; }
function requestError(message: string, status?: number, code?: string): AppError { const error = new Error(message) as AppError; error.status = status; error.code = code; return error; }
function restoreBadgeFocus(target: HTMLElement, category: FilterCategory) {
  requestAnimationFrame(() => {
    if (target.isConnected) {
      target.focus();
      return;
    }
    document.querySelector<HTMLElement>(`[data-filter-category="${category}"]`)?.focus();
  });
}
async function responseJson<T>(response: Response): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : `Request failed (${response.status})`;
    const code = body && typeof body === 'object' && 'code' in body && typeof body.code === 'string' ? body.code : undefined;
    throw requestError(message, response.status, code);
  }
  return body as T;
}
const decisionBadgeLabels: Record<DecisionLabel, string> = { needed: 'Needs decision', not_evidenced: 'Ok', unclear: 'Unclear' };
function AssessmentBadges({ item, assessment, debug, onOpen, filters, onToggleFilter }: { item: Item; assessment: UseWorkAssessmentsResult; debug: boolean; onOpen: (item: Item, inspect?: boolean) => void; filters: Filters; onToggleFilter: (filter: BadgeFilter) => void }) {
  if (item.status === 'done' || (assessment.scope && !assessment.scopeItemIds.has(item.id))) return null;
  const entry = assessment.entriesByItemId.get(item.id);
  const pending = assessment.pendingIds.has(item.id);
  const error = assessment.errorsByItemId.has(item.id);
  const mismatch = assessment.refreshRequiredIds.has(item.id);
  if (!pending && !error && !mismatch && (!entry || entry.state !== 'current' || !entry.assessment)) return null;
  const state: 'current' | 'pending' | 'failed' | 'refresh' = error ? 'failed' : mismatch ? 'refresh' : pending ? 'pending' : 'current';
  const decision = state === 'current' ? entry?.assessment?.labels.decision : undefined;
  const text = decision ? decisionLabels[decision] : state === 'pending' ? 'Updating…' : state === 'failed' ? 'Assessment failed' : 'Refresh needed';
  const chip = <Badge className={`field-provenance assessment-chip assessment-${state}`} title={decision ? `Goalie: ${text}` : text} variant="outline"><Sparkles aria-hidden="true" /><span>{decision ? decisionBadgeLabels[decision] : text}</span></Badge>;
  if (state === 'current' && decision) {
    const filterButton = <Button aria-label={`Filter by decision: ${text}`} aria-pressed={filters.assessmentDecisions.includes(decision)} className={`assessment-chip-button ${filters.assessmentDecisions.includes(decision) ? 'filter-badge-selected' : ''}`} data-filter-badge-key={`assessmentDecisions-${decision}`} onClick={event => { const target = event.currentTarget; event.preventDefault(); event.stopPropagation(); onToggleFilter({ key: 'assessmentDecisions', value: decision }); restoreBadgeFocus(target, 'decisions'); }} type="button" variant="ghost">{chip}</Button>;
    return debug ? <><span className="assessment-filter-badge">{filterButton}</span><Button aria-label={`View assessment for ${item.title}`} className="assessment-inspect-button" onClick={event => { event.preventDefault(); event.stopPropagation(); onOpen(item, true); }} type="button" variant="ghost"><span className="sr-only">Inspect</span><Sparkles aria-hidden="true" /></Button></> : filterButton;
  }
  return state === 'failed' || state === 'refresh' ? <Button aria-label={`View assessment for ${item.title}`} className="assessment-chip-button" onClick={event => { event.preventDefault(); event.stopPropagation(); onOpen(item, true); }} type="button" variant="ghost">{chip}</Button> : chip;
}
function CommandForm({ children, onSubmit, labelledBy }: { children: ReactNode; onSubmit: (event: FormEvent<HTMLFormElement>) => void; labelledBy: string }) { return <form aria-labelledby={labelledBy} className="work-form" onSubmit={onSubmit}>{children}</form>; }
function Field({ label, id, children, hint }: { label: ReactNode; id: string; children: ReactNode; hint?: string }) { return <div className="field"><Label htmlFor={id}>{label}</Label>{children}{hint ? <p className="field-hint">{hint}</p> : null}</div>; }
function restoreEditorFocus(event: Event, opener: HTMLElement | null) {
  event.preventDefault();
  const target = opener?.isConnected ? opener : document.querySelector<HTMLElement>('.page-actions button:not(:disabled), .work-header button[aria-label="Refresh shared work"]');
  target?.focus();
}

function ThemeControl({ theme, onChange }: { theme: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  return <Select value={theme} onValueChange={value => onChange(value as ThemePreference)}><SelectTrigger aria-label="Color theme" className="theme-trigger" id="theme-control"><SunMoon aria-hidden="true" className="size-4 shrink-0" /><SelectValue /></SelectTrigger><SelectContent><SelectItem value="system">System theme</SelectItem><SelectItem value="light">Light theme</SelectItem><SelectItem value="dark">Dark theme</SelectItem></SelectContent></Select>;
}
function Header({ user, theme, onTheme, onOpenMenu, onRefresh, refreshing, onSignOut, signingOut }: { user: Person; theme: ThemePreference; onTheme: (theme: ThemePreference) => void; onOpenMenu: () => void; onRefresh: () => void; refreshing: boolean; onSignOut: () => void; signingOut: boolean }) {
  return <header className="work-header"><div className="header-brand"><Button aria-label="Open navigation" className="mobile-nav-button" onClick={onOpenMenu} size="icon" variant="ghost"><Menu /></Button><span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 25V8h18v17M11 18l4 4 7-9" /></svg></span><div><strong>Goalie</strong></div></div><div className="header-actions"><ThemeControl onChange={onTheme} theme={theme} /><Button aria-label="Refresh shared work" disabled={refreshing} onClick={onRefresh} size="sm" variant="ghost"><RefreshCw className={refreshing ? 'spin' : ''} /> <span className="header-action-label">Refresh</span></Button><Button aria-label="Sign out" disabled={signingOut} onClick={onSignOut} size="sm" variant="ghost"><span className="header-action-label">Sign out</span><span className="mobile-action-label" aria-hidden="true">Exit</span></Button><span className="user-chip"><span className="avatar" aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span><span className="user-name">{user.name}</span><Badge variant="secondary">{user.role}</Badge></span></div></header>;
}
function SidebarContent({ section, scope, onSection, onScope, onClose, debug, onDebugChange, aiEnabled, aiAvailable, onAIChange }: { section: Section; scope: WorkScope; onSection: (value: Section) => void; onScope: (value: WorkScope) => void; onClose?: () => void; debug: boolean; onDebugChange: (value: boolean) => void; aiEnabled: boolean; aiAvailable: boolean; onAIChange: (value: boolean) => void }) {
  const chooseScope = (next: WorkScope) => { onScope(next); onClose?.(); };
  const chooseSection = (next: Section) => { onSection(next); onClose?.(); };
  return <><div className="sidebar-mobile-heading"><strong>Navigation</strong>{onClose ? <Button aria-label="Close navigation" onClick={onClose} size="icon" variant="ghost"><X /></Button> : null}</div><nav aria-label="Workspace navigation"><p className="sidebar-label">Workspace</p><Button className={`nav-link ${scope === 'all' && section === 'work' ? 'active' : ''}`} onClick={() => chooseScope('all')} type="button" variant="ghost"><ListChecks /> All work</Button><Button className={`nav-link ${scope === 'mine' && section === 'work' ? 'active' : ''}`} onClick={() => chooseScope('mine')} type="button" variant="ghost"><Target /> My work</Button><p className="sidebar-label">Manage</p><Button className={`nav-link ${section === 'goals' ? 'active' : ''}`} onClick={() => chooseSection('goals')} type="button" variant="ghost"><Target /> Goals</Button><Button className={`nav-link ${section === 'streams' ? 'active' : ''}`} onClick={() => chooseSection('streams')} type="button" variant="ghost"><FolderKanban /> Workstreams</Button><Button className={`nav-link ${section === 'tags' ? 'active' : ''}`} onClick={() => chooseSection('tags')} type="button" variant="ghost"><Tags /> Shared tags</Button><Button className={`nav-link ${section === 'people' ? 'active' : ''}`} onClick={() => chooseSection('people')} type="button" variant="ghost"><Users /> People</Button></nav><div className="sidebar-footer"><Button aria-checked={aiEnabled} aria-label={aiAvailable ? `AI assistance ${aiEnabled ? 'on' : 'off'}` : 'AI assistance unavailable'} className="sidebar-switch" disabled={!aiAvailable} onClick={() => onAIChange(!aiEnabled)} role="switch" type="button" variant="ghost"><span>AI assistance</span><span className="sidebar-switch-state">{aiAvailable ? (aiEnabled ? 'On' : 'Off') : 'Unavailable'}</span></Button><Button aria-checked={debug} aria-label={`Debug mode ${debug ? 'on' : 'off'}`} className="sidebar-switch" onClick={() => onDebugChange(!debug)} role="switch" type="button" variant="ghost"><span>Debug mode</span><span className="sidebar-switch-state">{debug ? 'On' : 'Off'}</span></Button></div></>;
}
function Sidebar({ section, scope, onSection, onScope, debug, onDebugChange, aiEnabled, aiAvailable, onAIChange }: { section: Section; scope: WorkScope; onSection: (value: Section) => void; onScope: (value: WorkScope) => void; debug: boolean; onDebugChange: (value: boolean) => void; aiEnabled: boolean; aiAvailable: boolean; onAIChange: (value: boolean) => void }) { return <aside className="work-sidebar"><SidebarContent aiAvailable={aiAvailable} aiEnabled={aiEnabled} debug={debug} onAIChange={onAIChange} onDebugChange={onDebugChange} onSection={onSection} onScope={onScope} scope={scope} section={section} /></aside>; }
function MobileNavigation({ open, onOpenChange, section, scope, onSection, onScope, debug, onDebugChange, aiEnabled, aiAvailable, onAIChange }: { open: boolean; onOpenChange: (open: boolean) => void; section: Section; scope: WorkScope; onSection: (value: Section) => void; onScope: (value: WorkScope) => void; debug: boolean; onDebugChange: (value: boolean) => void; aiEnabled: boolean; aiAvailable: boolean; onAIChange: (value: boolean) => void }) { return <Dialog modal open={open} onOpenChange={onOpenChange}><DialogContent aria-describedby={undefined} aria-label="Workspace navigation" className="mobile-nav-dialog"><DialogTitle>Navigation</DialogTitle><SidebarContent aiAvailable={aiAvailable} aiEnabled={aiEnabled} debug={debug} onAIChange={onAIChange} onClose={() => onOpenChange(false)} onDebugChange={onDebugChange} onSection={onSection} onScope={onScope} scope={scope} section={section} /></DialogContent></Dialog>; }

function ItemDetails({ item, snapshot }: { item: Item; snapshot: Snapshot }) {
  const latest = snapshot.updates.filter(update => update.itemId === item.id).at(-1);
  const stream = snapshot.workstreams.find(candidate => candidate.id === item.workstreamId);
  const contextualGoals = stream ? snapshot.goals.filter(goal => stream.goalIds.includes(goal.id)) : [];
  return <div className="item-details">
    <p className={item.description ? 'record-description' : 'record-empty'}>{item.description || 'No description yet.'}</p>
    <div className="item-detail-grid">
      <div className="record-meta"><span className="ui-label">Due</span><span className={item.dueDate ? 'record-value' : 'record-empty'}>{displayDate(item.dueDate)}</span></div>
      {item.blocker ? <div className="item-detail-blocker record-meta"><span className="ui-label">Blocker</span><span className="record-value">{item.blocker}</span></div> : null}
    </div>
    <div className="record-meta contextual-goals"><span className="ui-label">Contextual workstream goals</span>{contextualGoals.length ? <ul className="contextual-goal-list">{contextualGoals.map(goal => <li key={goal.id}>{goal.title}</li>)}</ul> : <span className="record-empty">No goals linked to this workstream.</span>}<span className="field-hint">Shown as workstream context; this item is not asserted to contribute to every goal.</span></div>
    {latest ? <div className="item-latest-note"><div className="record-meta"><span className="ui-label">Latest note</span><span className="record-value">{personName(snapshot.people, latest.authorId)} · <time className="record-value" dateTime={latest.createdAt}>{new Date(latest.createdAt).toLocaleString()}</time></span></div><p className="record-description">{latest.body}</p></div> : <p className="record-empty">No updates yet.</p>}
  </div>;
}

type RecordAction = { label: string; disabled?: boolean; description?: string; onSelect: (opener: HTMLElement | null) => void };
function RecordActions({ title, actions }: { title: string; actions: RecordAction[] }) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const transferFocusRef = useRef(false);
  const [open, setOpen] = useState(false);
  return <DropdownMenu open={open} onOpenChange={setOpen}><DropdownMenuTrigger asChild><Button aria-label={`More actions for ${title}`} className="record-action min-h-11 min-w-11" ref={triggerRef} size="icon" type="button" variant="ghost"><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="max-w-[calc(100vw-1rem)]" onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); setOpen(false); } }} onCloseAutoFocus={event => { if (transferFocusRef.current) { event.preventDefault(); transferFocusRef.current = false; } }}><div className="min-w-44">{actions.map(action => <DropdownMenuItem aria-label={action.description ? `${action.label}. ${action.description}` : action.label} className="min-h-11" disabled={action.disabled} key={action.label} onSelect={() => { transferFocusRef.current = true; action.onSelect(triggerRef.current); }} title={action.description}>{action.label}</DropdownMenuItem>)}</div></DropdownMenuContent></DropdownMenu>;
}
function WorkItemAccordion({ item, childItems, totalChildCount, snapshot, selectedId, matchingIds, onUpdates, onEdit, onAddSubtask, onToggleStar, openIds, onOpenIdsChange, assessment, debug, filters, onToggleFilter, canEdit, aiAvailable }: { item: Item; childItems: Item[]; totalChildCount: number; snapshot: Snapshot; selectedId: string | null; matchingIds: Set<string>; onUpdates: (item: Item, inspect?: boolean, opener?: HTMLElement | null) => void; onEdit: (item: Item, opener?: HTMLElement | null) => void; onAddSubtask: (item: Item, opener?: HTMLElement | null) => void; onToggleStar: (item: Item) => Promise<unknown>; openIds: string[]; onOpenIdsChange: (nextIds: string[], affectedIds: string[]) => void; assessment: UseWorkAssessmentsResult; debug: boolean; filters: Filters; onToggleFilter: (filter: BadgeFilter) => void; canEdit: boolean; aiAvailable: boolean }) {
  const assignees = peopleNames(snapshot.people, item.assigneeIds);
  const summary = item.assigneeIds.length > 2 ? `${peopleNames(snapshot.people, item.assigneeIds.slice(0, 2))} +${item.assigneeIds.length - 2}` : assignees;
  const streamTitle = snapshot.workstreams.find(stream => stream.id === item.workstreamId)?.title ?? 'No workstream';
  const contextOnly = !matchingIds.has(item.id);
  const childOpenIds = childItems.map(child => child.id).filter(id => openIds.includes(id));
  const [starPending, setStarPending] = useState(false);
  const starred = snapshot.starredItemIds.includes(item.id);
  const toggle = (filter: BadgeFilter, event: MouseEvent) => { const target = event.currentTarget as HTMLElement; event.preventDefault(); event.stopPropagation(); onToggleFilter(filter); restoreBadgeFocus(target, filter.key === 'statuses' ? 'status' : filter.key === 'workstreamIds' ? 'workstreams' : 'tags'); };
  const menuActions: RecordAction[] = [
    { label: 'Updates', onSelect: opener => onUpdates(item, false, opener) },
    { label: 'Edit', onSelect: opener => onEdit(item, opener) },
    ...(!item.parentId && canEdit ? [{ label: 'Add subtask', disabled: item.status === 'done', description: item.status === 'done' ? 'Reopen this parent before adding a subtask.' : undefined, onSelect: (opener: HTMLElement | null) => onAddSubtask(item, opener) }] : []),
  ];
  return <AccordionItem className={`work-item ${selectedId === item.id ? 'selected' : ''}`} value={item.id}>
    <div className="work-item-heading">
      <div className="work-item-summary">
        <AccordionTrigger aria-label={`Expand work ${item.title}`} aria-describedby={`work-context-${item.id}`} className="item-trigger">
          <span className="work-row-copy"><strong className="record-value">{item.title}</strong>{totalChildCount ? <span className="work-row-context-note">{totalChildCount} subtask{totalChildCount === 1 ? '' : 's'}</span> : null}</span>
          <span className="work-row-meta"><span className={`row-assignees ${item.assigneeIds.length ? 'record-value' : 'record-empty'}`} title={assignees}>{summary}</span>{item.blocker ? <CircleAlert className="row-blocker-icon" aria-hidden="true" /> : null}</span>
        </AccordionTrigger>
        <div className="work-row-context" id={`work-context-${item.id}`}>
          <Button aria-label={`Filter by status: ${statusLabels[item.status]}`} aria-pressed={filters.statuses.includes(item.status)} className={`badge-toggle status-badge status-${item.status} ${filters.statuses.includes(item.status) ? 'filter-badge-selected' : ''}`} data-filter-badge-key={`statuses-${item.status}`} onClick={event => toggle({ key: 'statuses', value: item.status }, event)} type="button" variant="ghost">{statusLabels[item.status]}</Button>
          <Button aria-label={`Filter by workstream: ${streamTitle}`} aria-pressed={filters.workstreamIds.includes(item.workstreamId)} className={`badge-toggle workstream-badge ${filters.workstreamIds.includes(item.workstreamId) ? 'filter-badge-selected' : ''}`} data-filter-badge-key={`workstreamIds-${item.workstreamId}`} onClick={event => toggle({ key: 'workstreamIds', value: item.workstreamId }, event)} type="button" variant="ghost"><FolderKanban aria-hidden="true" /><span className="sr-only">Workstream: </span>{streamTitle}</Button>
          {aiAvailable ? <AssessmentBadges assessment={assessment} debug={debug} filters={filters} item={item} onOpen={onUpdates} onToggleFilter={onToggleFilter} /> : null}
          {item.tagIds.map(id => { const tag = snapshot.tags.find(candidate => candidate.id === id); return tag ? <Button aria-label={`Filter by tag: ${tag.name}`} aria-pressed={filters.tagIds.includes(tag.id)} className={`badge-toggle work-tag ${filters.tagIds.includes(tag.id) ? 'filter-badge-selected' : ''}`} data-filter-badge-key={`tagIds-${tag.id}`} key={tag.id} onClick={event => toggle({ key: 'tagIds', value: tag.id }, event)} type="button" variant="ghost"><Tags aria-hidden="true" /><span className="sr-only">Tag: </span>{tag.name}</Button> : null; })}
          {contextOnly ? <span className="work-row-context-note">Context for matching subtask</span> : null}
        </div>
      </div>
      <div className="work-item-actions">
        <Button aria-label={starred ? `Unstar ${item.title}` : `Star ${item.title}`} aria-pressed={starred} className={`record-action star-action ${starred ? 'starred' : ''}`} disabled={starPending} onClick={event => { event.preventDefault(); event.stopPropagation(); setStarPending(true); void onToggleStar(item).finally(() => setStarPending(false)); }} size="icon" title={starred ? 'Unstar' : 'Star'} type="button" variant="ghost">{starPending ? <LoaderCircle className="spin" aria-hidden="true" /> : <Star aria-hidden="true" fill={starred ? 'currentColor' : 'none'} />}</Button>
        <RecordActions actions={menuActions} title={item.title} />
      </div>
    </div>
    <AccordionContent className="item-content"><ItemDetails item={item} snapshot={snapshot} />{childItems.length ? <Accordion type="multiple" className="subtask-list" onValueChange={nextIds => onOpenIdsChange(nextIds, childItems.map(child => child.id))} value={childOpenIds}>{childItems.map(child => <WorkItemAccordion aiAvailable={aiAvailable} assessment={assessment} canEdit={canEdit} childItems={[]} debug={debug} filters={filters} item={child} key={child.id} matchingIds={matchingIds} onAddSubtask={onAddSubtask} onEdit={onEdit} onOpenIdsChange={onOpenIdsChange} onToggleFilter={onToggleFilter} onToggleStar={onToggleStar} onUpdates={onUpdates} openIds={openIds} selectedId={selectedId} snapshot={snapshot} totalChildCount={0} />)}</Accordion> : null}</AccordionContent>
  </AccordionItem >;
}


const dueTimingLabels: Record<string, string> = { overdue: 'Overdue', due_soon: 'Due in 0–3 days', overdue_or_due_soon: 'Overdue or due soon', later: 'Later', undated: 'No due date' };
const decisionLabels: Record<string, string> = { needed: 'Decision needed', not_evidenced: 'No outstanding decision evidenced', unclear: 'Unclear' };

type FilterOption<T extends string = string> = { value: T; label: string; secondary?: string };
function FilterChoices<T extends string>({ idPrefix, label, options, values, onChange, searchable = false }: { idPrefix: string; label: string; options: Array<FilterOption<T>>; values: T[]; onChange: (values: T[]) => void; searchable?: boolean }) {
  const [query, setQuery] = useState('');
  useEffect(() => setQuery(''), [idPrefix]);
  const selectedUnknown = values.filter(value => !options.some(option => option.value === value)).map(value => ({ value, label: `${label} (${value})`, secondary: 'Unavailable' }));
  const allOptions = [...selectedUnknown, ...options];
  const normalized = query.trim().toLowerCase();
  const visible = normalized ? allOptions.filter(option => `${option.label} ${option.secondary ?? ''}`.toLowerCase().includes(normalized)) : allOptions;
  return <fieldset className="filter-choice-fieldset"><legend>{label}</legend>{searchable ? <Input aria-label={`Search ${label.toLowerCase()}`} className="filter-choice-search" id={`${idPrefix}-search`} onChange={event => setQuery(event.target.value)} placeholder={`Search ${label.toLowerCase()}`} value={query} /> : null}<div className="filter-choice-list" role="group" aria-label={label}>{visible.length ? visible.map(option => { const checked = values.includes(option.value); return <div className={`filter-choice-row ${checked ? 'checked' : ''}`} key={option.value}><Checkbox checked={checked} id={`${idPrefix}-${option.value}`} onCheckedChange={next => onChange(next === true ? [...values, option.value] : values.filter(value => value !== option.value))} /><Label htmlFor={`${idPrefix}-${option.value}`}><span>{option.label}</span>{option.secondary ? <small>{option.secondary}</small> : null}</Label></div>; }) : <p className="filter-choice-empty">{options.length ? 'No matching options' : `No ${label.toLowerCase()} available`}</p>}</div></fieldset>;
}
function scopedTagOptions(snapshot: Snapshot): Array<FilterOption> {
  return snapshot.tags.map(tag => ({ value: tag.id, label: tag.name, secondary: tag.workstreamId ? snapshot.workstreams.find(stream => stream.id === tag.workstreamId)?.title ?? 'Unavailable workstream' : 'Common' }));
}
function BaseFilterFields({ snapshot, filters, onFilters, idPrefix }: { snapshot: Snapshot; filters: WorkFilters; onFilters: (next: Partial<WorkFilters>) => void; idPrefix: string }) {
  const streams = snapshot.workstreams.map(stream => ({ value: stream.id, label: stream.title }));
  const goals = snapshot.goals.map(goal => ({ value: goal.id, label: goal.title }));
  const people = snapshot.people.map(person => ({ value: person.id, label: person.name }));
  const tags = scopedTagOptions(snapshot);
  return <div className="filter-dialog-fields">
    <Field id={`${idPrefix}-search`} label="Search"><Input id={`${idPrefix}-search`} onChange={event => onFilters({ search: event.target.value })} value={filters.search} /></Field>
    <FilterChoices idPrefix={`${idPrefix}-workstream`} label="Workstreams" options={streams} searchable values={filters.workstreamIds} onChange={workstreamIds => onFilters({ workstreamIds })} />
    <FilterChoices idPrefix={`${idPrefix}-goal`} label="Workstream goals" options={goals} searchable values={filters.goalIds} onChange={goalIds => onFilters({ goalIds })} />
    <FilterChoices idPrefix={`${idPrefix}-assignee`} label="Assignees" options={people} searchable values={filters.assigneeIds} onChange={assigneeIds => onFilters({ assigneeIds })} />
    <FilterChoices idPrefix={`${idPrefix}-status`} label="Status" options={[{ value: 'todo', label: 'To do' }, { value: 'doing', label: 'In progress' }, { value: 'done', label: 'Done' }]} values={filters.statuses} onChange={statuses => onFilters({ statuses })} />
    <FilterChoices idPrefix={`${idPrefix}-tag`} label="Tags" options={tags} searchable values={filters.tagIds} onChange={tagIds => onFilters({ tagIds })} />
    <Field id={`${idPrefix}-due`} label="Due timing"><Select value={filters.dueTiming || 'all'} onValueChange={value => onFilters({ dueTiming: value === 'all' ? '' : value as WorkFilters['dueTiming'] })}><SelectTrigger id={`${idPrefix}-due`}><SelectValue placeholder="All due dates" /></SelectTrigger><SelectContent><SelectItem value="all">All due dates</SelectItem>{Object.entries(dueTimingLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field>
  </div>;
}
function FilterDialog({ snapshot, filters, onFilters, openCategory, onOpenCategory, onCloseAutoFocus, aiAvailable }: { snapshot: Snapshot; filters: Filters; onFilters: (next: Partial<Filters>) => void; openCategory: FilterCategory; onOpenCategory: (category: FilterCategory) => void; onCloseAutoFocus: (event: Event) => void; aiAvailable: boolean }) {
  const category = openCategory;
  const streams = snapshot.workstreams.map(stream => ({ value: stream.id, label: stream.title }));
  const goals = snapshot.goals.map(goal => ({ value: goal.id, label: goal.title }));
  const people = snapshot.people.map(person => ({ value: person.id, label: person.name }));
  const tags = scopedTagOptions(snapshot);
  const title = category === 'status' ? 'Status filters' : category === 'tags' ? 'Tag filters' : category === 'decisions' ? 'Decision filters' : category === 'workstreams' ? 'Workstream filters' : 'More filters';
  const clear = () => category === 'status' ? onFilters({ statuses: [] }) : category === 'tags' ? onFilters({ tagIds: [] }) : category === 'decisions' ? onFilters({ assessmentDecisions: [] }) : category === 'workstreams' ? onFilters({ workstreamIds: [] }) : onFilters({ goalIds: [], assigneeIds: [], dueTiming: '' });
  return <Dialog modal open={category !== null && (category !== 'decisions' || aiAvailable)} onOpenChange={open => { if (!open) onOpenCategory(null); }}><DialogContent aria-describedby="filter-dialog-help" aria-label={title} className="filter-dialog" onCloseAutoFocus={onCloseAutoFocus}><DialogTitle>{title}</DialogTitle><p className="field-hint" id="filter-dialog-help">Match any selected value. Different categories combine.</p><div className="filter-dialog-body">{category === 'status' ? <FilterChoices idPrefix="filter-status" label="Status" options={[{ value: 'todo', label: 'To do' }, { value: 'doing', label: 'In progress' }, { value: 'done', label: 'Done' }]} values={filters.statuses} onChange={statuses => onFilters({ statuses })} /> : category === 'tags' ? <FilterChoices idPrefix="filter-tags" label="Tags" options={tags} searchable values={filters.tagIds} onChange={tagIds => onFilters({ tagIds })} /> : category === 'decisions' ? <FilterChoices idPrefix="filter-decisions" label="Decisions" options={Object.entries(decisionLabels).map(([value, label]) => ({ value: value as DecisionLabel, label }))} values={filters.assessmentDecisions} onChange={assessmentDecisions => onFilters({ assessmentDecisions })} /> : category === 'workstreams' ? <FilterChoices idPrefix="filter-workstreams" label="Workstreams" options={streams} searchable values={filters.workstreamIds} onChange={workstreamIds => onFilters({ workstreamIds })} /> : <div className="filter-dialog-fields filter-more-fields"><FilterChoices idPrefix="filter-goals" label="Workstream goals" options={goals} searchable values={filters.goalIds} onChange={goalIds => onFilters({ goalIds })} /><FilterChoices idPrefix="filter-assignees" label="Assignees" options={people} searchable values={filters.assigneeIds} onChange={assigneeIds => onFilters({ assigneeIds })} /><Field id="filter-due" label="Due timing"><Select value={filters.dueTiming || 'all'} onValueChange={value => onFilters({ dueTiming: value === 'all' ? '' : value as WorkFilters['dueTiming'] })}><SelectTrigger id="filter-due"><SelectValue placeholder="All due dates" /></SelectTrigger><SelectContent><SelectItem value="all">All due dates</SelectItem>{Object.entries(dueTimingLabels).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field></div>}</div><div className="filter-dialog-actions"><Button onClick={clear} type="button" variant="ghost">Clear {category === 'more' ? 'more filters' : 'category'}</Button><Button onClick={() => onOpenCategory(null)} type="button">Done</Button></div></DialogContent></Dialog>;
}
function FilterBar({ snapshot, filters, onFilters, scope: _scope, aiAvailable }: { snapshot: Snapshot; filters: Filters; onFilters: (next: Partial<Filters>) => void; scope: WorkScope; aiAvailable: boolean }) {
  const [openCategory, setOpenCategory] = useState<FilterCategory>(null);
  const [expanded, setExpanded] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const openerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const chipRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const groups = [
    { key: 'statuses' as const, label: 'Status', values: filters.statuses, names: filters.statuses.map(value => statusLabels[value]), category: 'status' as const },
    { key: 'tagIds' as const, label: 'Tags', values: filters.tagIds, names: filters.tagIds.map(id => snapshot.tags.find(tag => tag.id === id)?.name ?? `Unavailable (${id})`), category: 'tags' as const },
    ...(aiAvailable ? [{ key: 'assessmentDecisions' as const, label: 'Decisions', values: filters.assessmentDecisions, names: filters.assessmentDecisions.map(value => decisionLabels[value]), category: 'decisions' as const }] : []),
    { key: 'workstreamIds' as const, label: 'Workstreams', values: filters.workstreamIds, names: filters.workstreamIds.map(id => snapshot.workstreams.find(stream => stream.id === id)?.title ?? `Unavailable (${id})`), category: 'workstreams' as const },
    { key: 'goalIds' as const, label: 'Workstream goal', values: filters.goalIds, names: filters.goalIds.map(id => snapshot.goals.find(goal => goal.id === id)?.title ?? `Unavailable (${id})`), category: 'more' as const },
    { key: 'assigneeIds' as const, label: 'Assignee', values: filters.assigneeIds, names: filters.assigneeIds.map(id => snapshot.people.find(person => person.id === id)?.name ?? `Unavailable (${id})`), category: 'more' as const },
    { key: 'dueTiming' as const, label: 'Due', values: filters.dueTiming ? [filters.dueTiming] : [], names: filters.dueTiming ? [dueTimingLabels[filters.dueTiming]] : [], category: 'more' as const },
  ];
  const active = groups.flatMap(group => group.values.map((value, index) => ({ ...group, value, name: group.names[index] })));
  const count = active.length + Number(filters.starredOnly);
  const moreCount = filters.goalIds.length + filters.assigneeIds.length + Number(Boolean(filters.dueTiming));
  const clear = () => onFilters({ ...DEFAULT_WORK_FILTERS, assessmentDecisions: [], search: filters.search });
  const visibleActive = active.slice(0, expanded ? active.length : 4);
  const remove = (group: typeof groups[number], value: string) => {
    const removedIndex = active.findIndex(filter => filter.key === group.key && filter.value === value);
    const remaining = active.filter(filter => !(filter.key === group.key && filter.value === value));
    const fallback = remaining[removedIndex] ?? remaining[removedIndex - 1];
    onFilters(group.key === 'dueTiming' ? { dueTiming: '' } : { [group.key]: group.values.filter(candidate => candidate !== value) });
    requestAnimationFrame(() => {
      if (fallback) chipRefs.current[`${fallback.key}-${fallback.value}`]?.focus();
      else openerRefs.current[group.category]?.focus();
    });
  };
  return <><div className="filterbar" role="search"><div className="search-field"><Search aria-hidden="true" /><Input aria-label="Search work by title, description, tags, or people" onChange={event => onFilters({ search: event.target.value })} placeholder="Search work, tags, or people" value={filters.search} /></div><div className="filter-actions"><Button aria-pressed={filters.starredOnly} onClick={() => onFilters({ starredOnly: !filters.starredOnly })} type="button" variant={filters.starredOnly ? 'default' : 'outline'}><Star aria-hidden="true" fill={filters.starredOnly ? 'currentColor' : 'none'} />Starred only</Button>{(aiAvailable ? ['status', 'tags', 'decisions', 'workstreams', 'more'] : ['status', 'tags', 'workstreams', 'more']).map(category => { const group = category === 'more' ? null : groups.find(candidate => candidate.category === category); const categoryCount = group ? group.values.length : moreCount; const label = category === 'status' ? 'Status' : category === 'tags' ? 'Tags' : category === 'decisions' ? 'Decisions' : category === 'workstreams' ? 'Workstreams' : 'More'; return <Button aria-expanded={openCategory === category} aria-haspopup="dialog" className={categoryCount ? 'filter-category-active' : ''} data-filter-category={category} id={`filter-category-${category}`} key={category} onClick={event => { openerRef.current = event.currentTarget; openerRefs.current[category] = event.currentTarget; setOpenCategory(category as FilterCategory); }} ref={button => { openerRefs.current[category] = button; }} type="button" variant="outline">{category === 'decisions' ? <Sparkles aria-hidden="true" /> : <Filter aria-hidden="true" />}{label}{categoryCount ? <span className="filter-category-count">{categoryCount}</span> : null}</Button>; })}<Button disabled={!count} onClick={clear} type="button" variant="ghost">Clear filters</Button></div></div>{active.length ? <div className="applied-filters" aria-label="Applied filters">{visibleActive.map((filter, index) => { const showLabel = index === 0 || visibleActive[index - 1].key !== filter.key; return <Button aria-label={`Remove ${filter.label} filter ${filter.name}`} className="applied-filter" key={`${filter.key}-${filter.value}`} onClick={() => remove(filter, filter.value)} ref={button => { chipRefs.current[`${filter.key}-${filter.value}`] = button; }} type="button" variant="outline"><span>{showLabel ? <strong>{filter.label}: </strong> : null}{filter.name}</span><X aria-hidden="true" /></Button>; })}{active.length > 4 ? <Button className="filter-reveal" onClick={() => setExpanded(value => !value)} type="button" variant="ghost">{expanded ? 'Show fewer' : `Show all ${active.length} selected`}</Button> : null}</div> : null}<FilterDialog aiAvailable={aiAvailable} filters={filters} onCloseAutoFocus={event => { event.preventDefault(); openerRef.current?.focus(); }} onFilters={onFilters} onOpenCategory={setOpenCategory} openCategory={openCategory} snapshot={snapshot} /></>;
}
function scopeSummary(scope: AssessmentScope | null, snapshot: Snapshot): string {
  if (!scope) return 'No scope saved';
  const parts = [scope.scope === 'mine' ? 'My work' : 'All active work'];
  if (scope.search.trim()) parts.push(`matching “${scope.search.trim()}”`);
  const labelValues = (values: string[], lookup: (id: string) => string | undefined, fallback: string) => values.length ? values.map(id => lookup(id) ?? `${fallback} (${id})`).join(' or ') : '';
  const streams = labelValues(scope.workstreamIds, id => snapshot.workstreams.find(stream => stream.id === id)?.title, 'Unavailable workstream'); if (streams) parts.push(streams);
  const goals = labelValues(scope.goalIds, id => snapshot.goals.find(goal => goal.id === id)?.title, 'Unavailable workstream goal'); if (goals) parts.push(goals);
  const people = labelValues(scope.assigneeIds, id => snapshot.people.find(person => person.id === id)?.name, 'Unavailable assignee'); if (people) parts.push(people);
  if (scope.statuses.length) parts.push(scope.statuses.map(status => statusLabels[status] ?? `Unavailable status (${status})`).join(' or '));
  const tags = labelValues(scope.tagIds, id => snapshot.tags.find(tag => tag.id === id)?.name, 'Unavailable tag'); if (tags) parts.push(tags);
  if (scope.starredOnly) parts.push('starred');
  if (scope.dueTiming) parts.push(dueTimingLabels[scope.dueTiming] ?? 'due timing');
  return parts.join(' · ');
}
function ScopeEditor({ snapshot, actorId, currentView, viewScope, assessment, onClose }: { snapshot: Snapshot; actorId: string; currentView: Filters; viewScope: WorkScope; assessment: UseWorkAssessmentsResult; onClose: () => void }) {
  const copyScope = (scope: AssessmentScope | null): AssessmentScope => scope ? { ...scope, workstreamIds: [...scope.workstreamIds], goalIds: [...scope.goalIds], assigneeIds: [...scope.assigneeIds], statuses: [...scope.statuses], tagIds: [...scope.tagIds] } : { ...DEFAULT_WORK_FILTERS, scope: 'all' };
  const [draft, setDraft] = useState<AssessmentScope>(() => copyScope(assessment.scope));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(copyScope(assessment.scope)); }, [assessment.scope]);
  const update = (next: Partial<AssessmentScope>) => setDraft(previous => ({ ...previous, ...next }));
  const preview = !draft.dueTiming || assessment.serverAsOf ? snapshot.items.filter(item => item.status !== 'done' && matchesBaseWorkFilters(item, snapshot, draft, draft.scope, actorId, assessment.serverAsOf)).length : null;
  const save = async () => { setSaving(true); try { if (await assessment.setScope(draft)) onClose(); } finally { setSaving(false); } };
  const copyCurrent = () => update({ search: currentView.search, workstreamIds: [...currentView.workstreamIds], goalIds: [...currentView.goalIds], assigneeIds: [...currentView.assigneeIds], statuses: [...currentView.statuses], tagIds: [...currentView.tagIds], starredOnly: currentView.starredOnly, dueTiming: currentView.dueTiming, scope: viewScope });
  return <Dialog modal open onOpenChange={open => { if (!open && !saving && !assessment.savingScope) onClose(); }}><DialogContent aria-describedby={undefined} aria-label="Choose work for Goalie" className="scope-dialog"><DialogTitle>Choose work for Goalie</DialogTitle><p className="field-hint">Saved rules are independent from the filters you use to browse. They apply to active work while viewing this page and to the item opened in Updates.</p><div className="scope-editor-actions"><Button disabled={saving || assessment.savingScope} onClick={copyCurrent} type="button" variant="outline">Use current view filters</Button><Button disabled={saving || assessment.savingScope} onClick={() => update({ scope: draft.scope === 'all' ? 'mine' : 'all' })} type="button" variant="outline">Use {draft.scope === 'all' ? 'My work' : 'All work'}</Button></div><BaseFilterFields filters={draft} idPrefix="scope" onFilters={update} snapshot={snapshot} /><Button aria-pressed={draft.starredOnly} className="scope-star-toggle" onClick={() => update({ starredOnly: !draft.starredOnly })} type="button" variant={draft.starredOnly ? 'default' : 'outline'}><Star aria-hidden="true" fill={draft.starredOnly ? 'currentColor' : 'none'} />Starred only</Button>{preview !== null ? <p className="scope-preview">{preview} active item{preview === 1 ? '' : 's'} would be in scope.</p> : <p className="scope-preview">Choose a due timing after shared work has a current date.</p>}<div className="scope-dialog-actions"><Button disabled={saving || assessment.savingScope} onClick={onClose} type="button" variant="outline">Cancel</Button><Button disabled={saving || assessment.savingScope} onClick={() => { void save(); }} type="button">{saving || assessment.savingScope ? 'Saving…' : 'Save scope'}</Button></div></DialogContent></Dialog>;
}

function WorkList({ snapshot, filters, selectedId, matchingIds, onUpdates, onEdit, onAddSubtask, onToggleStar, onToggleFilter, assessment, userId, debug, canEdit, aiAvailable }: { snapshot: Snapshot; filters: Filters; selectedId: string | null; matchingIds: Set<string>; onUpdates: (item: Item, inspect?: boolean, opener?: HTMLElement | null) => void; onEdit: (item: Item, opener?: HTMLElement | null) => void; onAddSubtask: (item: Item, opener?: HTMLElement | null) => void; onToggleStar: (item: Item) => Promise<unknown>; onToggleFilter: (filter: BadgeFilter) => void; assessment: UseWorkAssessmentsResult; userId: string; debug: boolean; canEdit: boolean; aiAvailable: boolean }) {
  const matching = snapshot.items.filter(item => matchingIds.has(item.id));
  const contextIds = new Set(matching.filter(item => item.parentId).map(item => item.parentId as string));
  const visibleIds = new Set([...matchingIds, ...contextIds]);
  const visible = snapshot.items.filter(item => visibleIds.has(item.id));
  const totalChildCounts = new Map<string, number>();
  snapshot.items.forEach(item => { if (item.parentId) totalChildCounts.set(item.parentId, (totalChildCounts.get(item.parentId) ?? 0) + 1); });
  const filterActive = Boolean(filters.starredOnly || filters.search.trim() || filters.workstreamIds.length || filters.goalIds.length || filters.assigneeIds.length || filters.statuses.length || filters.tagIds.length || filters.dueTiming || (aiAvailable && filters.assessmentDecisions.length));
  const noStars = filters.starredOnly && snapshot.starredItemIds.length === 0;
  const preferenceStorageKey = `goalie:work-accordion:${userId}`;
  const maxStoredChoices = 500;
  const boundChoices = (choices: Record<string, boolean>) => {
    const ids = Object.keys(choices);
    if (ids.length <= maxStoredChoices) return choices;
    const bounded: Record<string, boolean> = {};
    ids.slice(-maxStoredChoices).forEach(id => { bounded[id] = choices[id]; });
    return bounded;
  };
  const [preferences, setPreferences] = useState<Record<string, boolean>>({});
  const [loadedPreferenceKey, setLoadedPreferenceKey] = useState<string | null>(null);
  useEffect(() => {
    let loaded: Record<string, boolean> = {};
    try {
      const raw = window.localStorage.getItem(preferenceStorageKey);
      if (raw) {
        const candidate: unknown = JSON.parse(raw);
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
          const parsed: Record<string, boolean> = {};
          Object.entries(candidate as Record<string, unknown>).forEach(([id, value]) => { if (typeof value === 'boolean') parsed[id] = value; });
          loaded = boundChoices(parsed);
        }
      }
    } catch {
      loaded = {};
    }
    setPreferences(loaded);
    setLoadedPreferenceKey(preferenceStorageKey);
  }, [preferenceStorageKey]);
  useEffect(() => {
    if (loadedPreferenceKey !== preferenceStorageKey) return;
    try {
      window.localStorage.setItem(preferenceStorageKey, JSON.stringify(preferences));
    } catch {
      // Browser storage can be unavailable; in-memory choices still work.
    }
  }, [loadedPreferenceKey, preferenceStorageKey, preferences]);
  const preferencesReady = loadedPreferenceKey === preferenceStorageKey;
  const autoOpenIds = preferencesReady && filterActive ? contextIds : new Set<string>();
  const isOpen = (id: string, choices: Record<string, boolean>) => Object.prototype.hasOwnProperty.call(choices, id) ? choices[id] : autoOpenIds.has(id);
  const grouped = snapshot.workstreams.map(stream => ({ stream, items: visible.filter(item => item.workstreamId === stream.id && item.parentId === null), matchedCount: matching.filter(item => item.workstreamId === stream.id).length })).filter(group => group.items.length);
  const rootIds = grouped.flatMap(group => group.items.map(item => item.id));
  const openIds = visible.filter(item => isOpen(item.id, preferences)).map(item => item.id);
  const rootOpenIds = rootIds.filter(id => openIds.includes(id));
  const handleOpenIdsChange = useCallback((nextIds: string[], affectedIds: string[]) => {
    const nextSet = new Set(nextIds);
    setPreferences(previous => {
      const next = { ...previous };
      let changed = false;
      affectedIds.forEach(id => {
        const wasOpen = isOpen(id, previous);
        const isNowOpen = nextSet.has(id);
        if (wasOpen !== isNowOpen) {
          next[id] = isNowOpen;
          changed = true;
        }
      });
      return changed ? boundChoices(next) : previous;
    });
  }, [autoOpenIds]);
  return <section className="surface work-list-surface" aria-labelledby="page-title">
    <div className="surface-heading"><div><p>{matching.length} matched item{matching.length === 1 ? '' : 's'} across {grouped.length} workstream{grouped.length === 1 ? '' : 's'}</p></div></div>
    {grouped.length ? <Accordion type="multiple" value={rootOpenIds} onValueChange={nextIds => handleOpenIdsChange(nextIds, rootIds)} className="item-accordions">{grouped.flatMap(group => group.items.map(item => <WorkItemAccordion aiAvailable={aiAvailable} assessment={assessment} canEdit={canEdit} childItems={visible.filter(candidate => candidate.parentId === item.id)} debug={debug} filters={filters} item={item} key={item.id} matchingIds={matchingIds} onAddSubtask={onAddSubtask} onEdit={onEdit} onOpenIdsChange={handleOpenIdsChange} onToggleFilter={onToggleFilter} onToggleStar={onToggleStar} onUpdates={onUpdates} openIds={openIds} selectedId={selectedId} snapshot={snapshot} totalChildCount={totalChildCounts.get(item.id) ?? 0} />))}</Accordion> : <div className="empty-state"><ListChecks aria-hidden="true" /><h3>{noStars ? 'No starred work yet' : filterActive ? 'No work matches these filters' : 'No work yet'}</h3><p>{noStars ? 'Star work to keep it close at hand.' : filterActive ? 'Try clearing a filter or searching for something else.' : 'Create the first task to give the team a place to start.'}</p></div>}
  </section>;
}


function GoalList({ snapshot, canEdit, onEdit, onAddStream }: { snapshot: Snapshot; canEdit: boolean; onEdit: (goal: Goal, opener?: HTMLElement | null) => void; onAddStream: (goal: Goal, opener?: HTMLElement | null) => void }) {
  return <section className="surface manage-surface" aria-labelledby="page-title"><div className="surface-heading"><div><p>Keep shared outcomes visible without adding another planning model.</p></div></div>{snapshot.goals.length ? <div className="manage-list">{snapshot.goals.map(goal => <div className="manage-row" key={goal.id}><div><strong className="record-value">{goal.title}</strong><p className={goal.description ? 'record-description' : 'record-empty'}>{goal.description || 'No description yet.'}</p></div><div className="record-meta"><span className="ui-label">Target date</span><span className={goal.targetDate ? 'record-value' : 'record-empty'}>{displayDate(goal.targetDate)}</span></div><RecordActions title={goal.title} actions={[{ label: 'Edit', disabled: !canEdit, onSelect: opener => onEdit(goal, opener) }, { label: 'New workstream', disabled: !canEdit, onSelect: opener => onAddStream(goal, opener) }]} /></div>)}</div> : <div className="empty-state compact"><Target aria-hidden="true" /><h3>No goals yet</h3><p>Add a goal to give work a shared destination.</p></div>}</section>;
}
function StreamList({ snapshot, canEdit, onEdit, onAddTask }: { snapshot: Snapshot; canEdit: boolean; onEdit: (stream: Workstream, opener?: HTMLElement | null) => void; onAddTask: (stream: Workstream, opener?: HTMLElement | null) => void }) {
  return <section className="surface manage-surface" aria-labelledby="page-title">{snapshot.workstreams.length ? <div className="manage-list">{snapshot.workstreams.map(stream => <div className="manage-row" key={stream.id}><div><strong className="record-value">{stream.title}</strong><p className={stream.description ? 'record-description' : 'record-empty'}>{stream.description || 'No description yet.'}</p><div className="record-meta"><span className="ui-label">Lead</span><span className={stream.leadId ? 'record-value' : 'record-empty'}>{personName(snapshot.people, stream.leadId)}</span></div><div className="linked-goals"><span className="ui-label">Linked goals</span>{stream.goalIds.length ? <ul>{stream.goalIds.map(id => { const goal = snapshot.goals.find(candidate => candidate.id === id); return goal ? <li key={id}>{goal.title}</li> : null; })}</ul> : <p className="record-empty">No linked goals</p>}</div></div><div className="record-meta"><span className="ui-label">Items</span><span className="record-value">{snapshot.items.filter(item => item.workstreamId === stream.id).length} items</span></div><RecordActions title={stream.title} actions={[{ label: 'Edit', disabled: !canEdit, onSelect: opener => onEdit(stream, opener) }, { label: 'New task', disabled: !canEdit, onSelect: opener => onAddTask(stream, opener) }]} /></div>)}</div> : <div className="empty-state compact"><FolderKanban aria-hidden="true" /><h3>No workstreams yet</h3><p>Create one to hold the first shared task.</p></div>}</section>;
}
function TagList({ snapshot, canEditTag, onEdit }: { snapshot: Snapshot; canEditTag: (tag: Tag) => boolean; onEdit: (tag: Tag, opener?: HTMLElement | null) => void }) {
  return <section className="surface manage-surface" aria-labelledby="page-title"><div className="surface-heading"><div><p>Use a small, defined vocabulary to make work easy to find.</p></div></div>{snapshot.tags.length ? <div className="tag-directory">{snapshot.tags.map(tag => <div className="tag-directory-row" key={tag.id}><strong className="tag-name record-value">{tag.name}</strong><span className={tag.description ? 'record-description' : 'record-empty'}>{tag.description || 'No description yet.'}</span><span className="record-meta">{tag.workstreamId ? <span className="workstream-badge"><FolderKanban aria-hidden="true" /><span className="sr-only">Workstream: </span>{snapshot.workstreams.find(stream => stream.id === tag.workstreamId)?.title ?? 'Unknown workstream'}</span> : <span className="common-badge" title="Available across all workstreams"><Users aria-hidden="true" /><span>Common</span><span className="sr-only">Available across all workstreams</span></span>}</span><RecordActions title={tag.name} actions={[{ label: 'Edit', disabled: !canEditTag(tag), onSelect: opener => onEdit(tag, opener) }]} /></div>)}</div> : <div className="empty-state compact"><Tags aria-hidden="true" /><h3>No shared tags yet</h3><p>Define vocabulary only when it helps the team find work.</p></div>}</section>;
}
function PeopleList({ snapshot, isAdmin, onEdit }: { snapshot: Snapshot; isAdmin: boolean; onEdit: (person: Person, opener?: HTMLElement | null) => void }) {
  return <section className="surface manage-surface" aria-labelledby="page-title"><div className="surface-heading"><div><p>Access roles are admin (manage people), editor (manage work), and viewer (read-only).</p></div></div>{snapshot.people.length ? <div className="people-directory">{snapshot.people.map(person => <div className="people-row" key={person.id}><div className="people-identity"><span className="avatar" aria-hidden="true">{person.name.slice(0, 1).toUpperCase()}</span><div><strong className="record-value">{person.name}</strong><span className={person.email ? 'record-value' : 'record-empty'}><Mail aria-hidden="true" />{person.email}</span></div></div><Badge className="record-value" variant="secondary">{person.role}</Badge><RecordActions title={person.name} actions={[{ label: 'Edit', disabled: !isAdmin, onSelect: opener => onEdit(person, opener) }]} /></div>)}</div> : <div className="empty-state compact"><Users aria-hidden="true" /><h3>No people yet</h3><p>People are provisioned by the deployment administrator.</p></div>}</section>;
}

type AutofillState = UseWorkAutofillResult;

type AssistScope = 'item' | 'stream';
function latestMatchingSuggestion(results: AssistResult[], field: AssistField, value: string | null) {
  if (!value) return null;
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const suggestion = [...results[index].suggestions].reverse().find(candidate => candidate.field === field && candidate.value === value);
    if (suggestion) return { suggestion, result: results[index] };
  }
  return null;
}
function Provenance({ visible, available = true, debug, pending, results, field, value }: { visible: boolean; available?: boolean; debug: boolean; pending: boolean; results: AssistResult[]; field: AssistField; value: string | null }) {
  if (!visible || !available) return null;
  const match = !pending && debug ? latestMatchingSuggestion(results, field, value) : null;
  const badge = <span className="field-provenance"><Sparkles aria-hidden="true" />Suggested by Goalie</span>;
  if (!match) return badge;
  const { suggestion, result } = match;
  const fieldLabel = { workstreamId: 'Workstream', goalIds: 'Linked goal', tagIds: 'Tag', assigneeIds: 'Assignee' }[field];
  return <details className="provenance-details"><summary className="field-provenance" aria-label={`Inspect Goalie suggestion for ${fieldLabel}: ${suggestion.label}`}><Sparkles aria-hidden="true" />Suggested by Goalie<ChevronDown aria-hidden="true" /></summary><div className="provenance-scores" role="group" aria-label={`Goalie classification details for ${fieldLabel}: ${suggestion.label}`}><strong>{fieldLabel}: {suggestion.label}</strong><span>Selected score: {(suggestion.probability * 100).toFixed(1)}%</span><span>Model: {result.model}</span><span>Round trip: {Math.round(result.roundtripMs)} ms</span>{suggestion.alternatives.length ? <div><span>Classification options</span><ul>{suggestion.alternatives.map(option => <li key={option.value}><span>{option.label}</span><span>{(option.probability * 100).toFixed(1)}%</span></li>)}</ul></div> : <span>No alternatives returned.</span>}<span className="field-hint">Scores are model preferences, not calibrated certainty.</span></div></details>;
}
function AssistSurface({ available, autofill, status: statusOverride, error: errorOverride, onRetry, scope = 'item' }: { available: boolean; autofill: AutofillState; status?: AutofillState['status']; error?: string | null; onRetry?: () => void; scope?: AssistScope }) {
  const { enabled, error: autofillError, status: autofillStatus } = autofill;
  if (!available) return null;
  const status = !enabled ? 'off' : statusOverride ?? autofillStatus;
  const error = scope === 'stream' ? errorOverride : autofillError;
  const retry = onRetry ?? autofill.retry;
  const message = status === 'pending' ? 'Finding suggestions…' : status === 'filled' ? 'Suggestions added to this draft. Review before saving.' : status === 'empty' ? 'No new suggestions for this draft.' : status === 'error' ? 'Goalie could not suggest fields. You can continue manually.' : status === 'off' ? 'Suggestions are off. All fields remain editable.' : status === 'unavailable' ? 'Goalie is unavailable. Continue manually.' : 'Edit the title or description to get suggestions.';
  return <section className="assist-panel" aria-label="Goalie Suggestions"><p className="assist-status" role="status"><Sparkles className={status === 'pending' ? 'assist-pending-icon' : ''} aria-hidden="true" />{message}</p>{status === 'error' && error ? <Alert role="status" variant="destructive" className="assist-message"><CircleAlert aria-hidden="true" /><AlertDescription><span>{error}</span><Button onClick={retry} size="sm" type="button" variant="outline">Retry</Button></AlertDescription></Alert> : null}</section>;
}

function AssessmentInspection({ item, assessment, canEdit, debug, openRequest }: { item: Item; assessment: UseWorkAssessmentsResult; canEdit: boolean; debug: boolean; openRequest: number }) {
  const disclosure = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const readSequence = useRef(0);
  const entry = assessment.entriesByItemId.get(item.id);
  const details = assessment.detailsByItemId.get(item.id);
  const record = details?.record;
  const labels = record?.labels ?? entry?.assessment?.labels;
  const mismatch = assessment.refreshRequiredIds.has(item.id);
  const current = entry?.state === 'current' && !mismatch;
  const running = assessment.pendingIds.has(item.id);
  const runError = assessment.errorsByItemId.get(item.id);
  const active = item.status !== 'done';
  const inScope = assessment.scopeItemIds.has(item.id);
  const canRun = active && inScope && canEdit && assessment.enabled && assessment.provider.enabled && !assessment.locallyStopped && !mismatch;
  const state = !active ? 'Not applicable to completed work.' : !inScope ? 'Outside the saved Goalie scope.' : mismatch ? 'Refresh shared work to assess current data.' : running ? 'Assessing…' : runError ? 'Assessment failed.' : current ? 'Current assessment.' : entry?.state === 'stale' ? 'Previous assessment retained for history; it no longer matches the current saved work.' : 'Not assessed yet.';
  const entryIdentity = entry ? `${entry.state}\u0000${entry.currentInputKey ?? ''}\u0000${entry.assessment?.inputKey ?? ''}\u0000${entry.assessment?.assessedAt ?? ''}` : '';
  const load = useCallback(async () => {
    const sequence = ++readSequence.current;
    setLoading(true);
    setDetailError(null);
    const value = await assessment.loadDetails(item.id);
    if (readSequence.current !== sequence) return;
    setLoading(false);
    if (!value) setDetailError('Assessment details could not be loaded. Close and reopen this disclosure to retry.');
  }, [assessment.loadDetails, item.id]);
  useEffect(() => () => { readSequence.current += 1; }, []);
  useEffect(() => {
    if (!disclosure.current) return;
    setOpen(openRequest > 0);
    if (openRequest > 0) {
      const frame = requestAnimationFrame(() => disclosure.current?.querySelector('summary')?.focus());
      return () => cancelAnimationFrame(frame);
    }
  }, [openRequest]);
  useEffect(() => {
    if (!open || !entryIdentity || details) return;
    void load();
  }, [open, details, entryIdentity, load]);
  useEffect(() => {
    if (debug) return;
    setOpen(false);
    if (disclosure.current) disclosure.current.open = false;
  }, [debug]);
  if (!debug && !runError && current) return <p className="field-hint">Current assessment. Turn on Debug to inspect details.</p>;
  return <details className="assessment-details-panel" ref={disclosure} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>AI assessment</summary>
    <div className="assessment-detail-copy">
      <p role="status">{state}</p>
      {loading ? <p>Loading assessment details…</p> : null}
      {detailError || runError ? <p role="alert">{runError ? (debug ? runError.message : 'Assessment failed. Retry when assessments are on and this item is in scope.') : detailError}</p> : null}
      {labels ? <p><strong>{current ? 'Decision:' : 'Previous decision (not current):'}</strong> {decisionLabels[labels.decision] ?? 'Unclear'}</p> : null}
      {record ? <>
        <p>Assessed <time dateTime={record.assessedAt}>{new Date(record.assessedAt).toLocaleString()}</time>. UTC assessment day {record.asOf}.</p>
        <p>{record.origin === 'rules' ? 'Not enough item context to assess. Rules only; no model call occurred.' : 'Experimental model judgment, not an explanation or verified finding. No outstanding decision evidenced is not a guarantee that none exists; thin records can be misclassified.'}</p>
        {debug && details?.sourceContext ? <details><summary>Input considered</summary><pre>{JSON.stringify(assessmentModelState(details.sourceContext), null, 2)}</pre></details> : debug ? <p>Original input is no longer available because the source or rubric changed.</p> : null}
        {debug ? <details><summary>Assessment metadata</summary><p>Configured model: {assessment.provider.model ?? 'Unavailable'}</p><p>Requested model: {record.requestTemplate.model}</p><p>Resolved model: {record.response?.model ?? 'No model call'}</p><p>Round trip: {record.roundtripMs === null ? 'Not applicable' : `${record.roundtripMs} ms`}</p><p>Version: {record.version}</p>{record.response ? <><p>Raw model distributions; not calibrated accuracy.</p><pre>{JSON.stringify(record.response.answers, null, 2)}</pre></> : null}</details> : null}
        {debug ? <details><summary>Saved rubric</summary><pre>{JSON.stringify(record.requestTemplate.questions, null, 2)}</pre></details> : null}
      </> : null}
      {canRun && (runError || entry?.state === 'stale') ? <Button disabled={running} onClick={() => assessment.retryItem(item.id)} size="sm" type="button" variant="outline">Retry assessment</Button> : null}
      {!canRun && active ? <p className="field-hint">{!inScope ? 'This item is outside the saved Goalie scope.' : !canEdit ? 'Viewer access can inspect shared assessments but cannot run them.' : !assessment.enabled || assessment.locallyStopped ? 'Automatic assessments are off or locally stopped.' : !assessment.provider.enabled ? 'The private model is unavailable.' : 'Refresh shared work before assessing.'}</p> : null}
    </div>
  </details >;
}

function UpdatesPanel({ confirmationOpen, updateKind, setUpdateKind, onResolveBlocker, itemId, openerRef, snapshot, updateBody, setUpdateBody, onAddUpdate, onClose, saving, actionError, canEdit, actorId, isAdmin, editingUpdateId, editingUpdateBody, setEditingUpdateBody, onSaveUpdate, onCancelUpdate, onEditUpdate, onDeleteUpdate, assessment, assessmentOpenRequest, debug }: { confirmationOpen: boolean; updateKind: UpdateKind; setUpdateKind: (value: UpdateKind) => void; onResolveBlocker: () => void; itemId: string | null; openerRef: { current: HTMLElement | null }; snapshot: Snapshot; updateBody: string; setUpdateBody: (value: string) => void; onAddUpdate: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void; saving: boolean; actionError: AppError | null; canEdit: boolean; actorId: string; isAdmin: boolean; editingUpdateId: string | null; editingUpdateBody: string; setEditingUpdateBody: (value: string) => void; onSaveUpdate: (event: FormEvent<HTMLFormElement>) => void; onCancelUpdate: () => void; onEditUpdate: (id: string, body: string) => void; onDeleteUpdate: (id: string) => void; assessment: UseWorkAssessmentsResult; assessmentOpenRequest: number; debug: boolean }) {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1279px)').matches);
  useEffect(() => { const media = window.matchMedia('(max-width: 1279px)'); const update = () => setCompact(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  const item = itemId ? snapshot.items.find(candidate => candidate.id === itemId) : null;
  if (!item) return null;
  const stream = snapshot.workstreams.find(candidate => candidate.id === item.workstreamId);
  const updates = snapshot.updates.filter(update => update.itemId === item.id);
  const updateLabels: Record<UpdateKind, string> = { note: 'Note', blocker: 'Blocker raised', blocker_resolved: 'Blocker resolved' };
  return <Dialog open modal={compact && !confirmationOpen} onOpenChange={open => { if (!open) onClose(); }}><DialogContent aria-describedby={undefined} aria-label={`Updates for ${item.title}`} className="work-panel updates-panel" data-no-overlay={!compact || confirmationOpen} onInteractOutside={event => event.preventDefault()} onCloseAutoFocus={event => restoreEditorFocus(event, openerRef.current)}>
    <div className="panel-heading"><div><DialogTitle className="record-value" id="updates-panel-title">{item.title}</DialogTitle><span className="panel-context"><span className={stream ? 'record-value' : 'record-empty'}>{stream?.title ?? 'No workstream'}</span> · <span className="record-value">{statusLabels[item.status]}</span></span></div><Button aria-label="Close updates" disabled={saving} onClick={onClose} size="icon" variant="ghost"><X /></Button></div>
    {actionError ? <Alert variant="destructive" className="error-banner"><CircleAlert aria-hidden="true" /><AlertDescription>{actionError.message}</AlertDescription></Alert> : null}
    <section className="update-blocker" aria-labelledby="update-blocker-label"><div className="current-blocker-heading"><div className="record-meta"><span className="ui-label" id="update-blocker-label">Current blocker</span><span className={item.blocker ? 'record-value' : 'record-empty'}>{item.blocker || 'No current blocker'}</span></div>{canEdit && item.blocker ? <Button disabled={saving} onClick={onResolveBlocker} size="sm" type="button" variant="outline"><CheckCircle2 aria-hidden="true" />Resolve</Button> : null}</div></section>
    {debug ? <AssessmentInspection key={item.id} item={item} assessment={assessment} canEdit={canEdit} debug={debug} openRequest={assessmentOpenRequest} /> : null}
    {canEdit ? <form className="update-form" onSubmit={onAddUpdate}><div className="update-composer-type" aria-label="Update type" role="group"><Button aria-pressed={updateKind === 'note'} disabled={saving} onClick={() => setUpdateKind('note')} size="sm" type="button" variant={updateKind === 'note' ? 'default' : 'outline'}><StickyNote aria-hidden="true" />Note</Button><Button aria-pressed={updateKind === 'blocker'} disabled={saving} onClick={() => setUpdateKind('blocker')} size="sm" type="button" variant={updateKind === 'blocker' ? 'default' : 'outline'}><CircleAlert aria-hidden="true" />Blocker</Button></div><Textarea aria-label={updateKind === 'blocker' ? 'Describe blocker' : 'Write a note'} disabled={saving} maxLength={updateKind === 'blocker' ? 4000 : 10000} onChange={event => setUpdateBody(event.target.value)} placeholder={updateKind === 'blocker' ? 'Describe what is blocked and what is needed.' : 'Share a useful change or decision.'} value={updateBody} /><Button disabled={saving || !updateBody.trim()} size="sm" type="submit">{saving ? <LoaderCircle className="spin" /> : null}{updateKind === 'blocker' ? 'Raise blocker' : 'Add note'}</Button></form> : <p className="field-hint">Viewer access is read-only. You can review the saved timeline.</p>}
    <section className="timeline" aria-labelledby="timeline-heading"><div className="section-title"><h3 id="timeline-heading">Timeline</h3><span>{updates.length}</span></div><div className="update-list">{updates.length ? updates.map(update => { const kind = (update.kind ?? 'note') as UpdateKind; const canModify = canEdit && (isAdmin || update.authorId === actorId); return <article className={`update-note update-kind-${kind}`} key={update.id}><span className="timeline-marker" aria-hidden="true">{kind === 'blocker' ? <CircleAlert /> : kind === 'blocker_resolved' ? <CheckCircle2 /> : <StickyNote />}</span><div className="timeline-entry"><div className="timeline-entry-meta"><strong className="update-kind-label">{updateLabels[kind]}</strong><strong className="record-value">{personName(snapshot.people, update.authorId)}</strong><time className="record-value" dateTime={update.createdAt}>{new Date(update.createdAt).toLocaleString()}</time></div>{editingUpdateId === update.id ? <form className="update-edit-form" onSubmit={onSaveUpdate}><Textarea aria-label={`Edit ${updateLabels[kind].toLowerCase()}`} disabled={saving} onChange={event => setEditingUpdateBody(event.target.value)} value={editingUpdateBody} /><div className="update-actions"><Button disabled={saving || !editingUpdateBody.trim()} size="sm" type="submit">Save</Button><Button disabled={saving} onClick={onCancelUpdate} size="sm" type="button" variant="outline">Cancel</Button></div></form> : <><p className="record-description">{update.body}</p>{canModify ? <div className="update-actions"><Button aria-label={`Edit ${updateLabels[kind].toLowerCase()}`} className="record-action" disabled={saving} onClick={() => onEditUpdate(update.id, update.body)} size="sm" type="button" variant="ghost"><Pencil aria-hidden="true" /><span>Edit</span></Button><Button aria-label={`Delete ${updateLabels[kind].toLowerCase()}`} className="record-action" disabled={saving} onClick={() => onDeleteUpdate(update.id)} size="sm" type="button" variant="ghost"><Trash2 aria-hidden="true" /><span>Delete</span></Button></div> : null}</>}<p className="update-attribution"><span className="ui-label">Assignees at update</span>: <span className={update.assigneeIds === null ? 'record-empty' : 'record-value'}>{update.assigneeIds === null ? 'Not recorded' : peopleNames(snapshot.people, update.assigneeIds)}</span></p></div></article>; }) : <p className="record-empty">No updates yet.</p>}</div></section>
  </DialogContent></Dialog>;
}
function AssigneePicker({ people, selectedIds, onChange }: { people: Person[]; selectedIds: string[]; onChange: (ids: string[]) => void }) {
  const selectedNames = people.filter(person => selectedIds.includes(person.id)).map(person => person.name).join(', ');
  const triggerLabel = selectedNames ? `Assignees: ${selectedNames}` : 'Choose assignees';
  return <div className="field assignee-picker-field"><span className="field-label">Assignees</span><details className="assignee-picker" onBlur={event => { const next = event.relatedTarget; if (!next || !event.currentTarget.contains(next as Node)) event.currentTarget.open = false; }}><summary className="assignee-picker-trigger" aria-label={triggerLabel}><span>{selectedNames || 'Select assignees'}</span><ChevronDown aria-hidden="true" /></summary><div className="assignee-picker-menu" role="group" aria-label="Assign people">{people.map(person => <div className="check-row" key={person.id}>
    <Checkbox aria-label={`Assign ${person.name}`} checked={selectedIds.includes(person.id)} id={`item-assignee-${person.id}`} onCheckedChange={checked => onChange(checked ? [...selectedIds, person.id] : selectedIds.filter(id => id !== person.id))} />
    <Label htmlFor={`item-assignee-${person.id}`} onMouseDown={event => {
      // Keep focus inside the picker until native label activation focuses the checkbox.
      // Closing details during that focus transfer crashes Chrome 154.
      event.preventDefault();
    }}>{person.name}</Label>
  </div>)}</div></details></div>;
}

function WorkPanel({ confirmationOpen, panel, openerRef, snapshot, autofill, itemForm, setItemKind, itemKind, setGoalForm, setStreamForm, setTagForm, setPersonForm, goalForm, streamForm, tagForm, personForm, editingId, dirty, setDirty, onSave, onClose, onDelete, saving, actionError, canEdit, canDelete, isAdmin, userId, assist, csrfToken }: { panel: Panel; openerRef: { current: HTMLElement | null }; snapshot: Snapshot; autofill: AutofillState; itemForm: ItemInput | null; setItemKind: (value: ItemKind) => void; itemKind: ItemKind; setGoalForm: (value: GoalInput | null) => void; setStreamForm: (value: WorkstreamInput | null) => void; setTagForm: (value: TagInput | null) => void; setPersonForm: (value: PersonInput | null) => void; goalForm: GoalInput | null; streamForm: WorkstreamInput | null; tagForm: TagInput | null; personForm: PersonInput | null; editingId: string | null; dirty: boolean; setDirty: (value: boolean) => void; onSave: (event: FormEvent<HTMLFormElement>) => void; onClose: () => void; onDelete: () => void; saving: boolean; actionError: AppError | null; canEdit: boolean; canDelete: boolean; isAdmin: boolean; userId: string; assist: { enabled: boolean; model: string | null }; csrfToken: string } & { confirmationOpen: boolean }) {
  const [compact, setCompact] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1279px)').matches);
  const [suggestingGoals, setSuggestingGoals] = useState(false);
  const [goalSuggestionError, setGoalSuggestionError] = useState<string | null>(null);
  const [goalSuggestionStatus, setGoalSuggestionStatus] = useState<AutofillState['status']>(assist.enabled ? 'idle' : 'unavailable');
  const [suggestedGoalIds, setSuggestedGoalIds] = useState<string[]>([]);
  const [manuallyRemovedGoalIds, setManuallyRemovedGoalIds] = useState<string[]>([]);
  const [streamResults, setStreamResults] = useState<AssistResult[]>([]);
  const suggestionSequence = useRef(0);
  const suggestionAbortRef = useRef<AbortController | null>(null);
  const streamFormRef = useRef(streamForm);
  const streamTextKeyRef = useRef<string | null>(null);
  const streamDraftEditedRef = useRef(false);
  streamFormRef.current = streamForm;
  const selectedStream = itemForm?.workstreamId ? snapshot.workstreams.find(stream => stream.id === itemForm.workstreamId) : null;
  const linkedGoals = selectedStream ? snapshot.goals.filter(goal => selectedStream.goalIds.includes(goal.id)) : [];
  const hasChildren = Boolean(editingId && snapshot.items.some(child => child.parentId === editingId));
  const parentCandidates = itemForm && !hasChildren ? snapshot.items.filter(item => item.id !== editingId && item.workstreamId === itemForm.workstreamId && item.parentId === null) : [];
  const availableTags = itemForm ? snapshot.tags.filter(tag => !tag.workstreamId || tag.workstreamId === itemForm.workstreamId || itemForm.tagIds.includes(tag.id)) : [];
  const tagWritable = isAdmin || Boolean(tagForm?.workstreamId && snapshot.workstreams.some(stream => stream.id === tagForm.workstreamId && stream.leadId === userId));
  useEffect(() => { const media = window.matchMedia('(max-width: 1279px)'); const update = () => setCompact(media.matches); update(); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, []);
  useLayoutEffect(() => { suggestionSequence.current += 1; suggestionAbortRef.current?.abort(); suggestionAbortRef.current = null; setSuggestingGoals(false); setGoalSuggestionStatus(!assist.enabled ? 'unavailable' : autofill.enabled ? 'idle' : 'off'); return () => { suggestionSequence.current += 1; suggestionAbortRef.current?.abort(); suggestionAbortRef.current = null; }; }, [saving, snapshot.revision, panel, editingId, canEdit, assist.enabled, autofill.enabled, csrfToken]);
  useEffect(() => { streamTextKeyRef.current = null; streamDraftEditedRef.current = false; setSuggestedGoalIds([]); setManuallyRemovedGoalIds([]); setStreamResults([]); setGoalSuggestionError(null); setGoalSuggestionStatus(!assist.enabled ? 'unavailable' : autofill.enabled ? 'idle' : 'off'); }, [panel, editingId]);
  const panelTitle = panel === 'item' ? (editingId ? (canEdit ? 'Edit work' : 'View work') : 'New work') : panel === 'goal' ? (editingId ? 'Edit goal' : 'New goal') : panel === 'stream' ? (editingId ? 'Edit workstream' : 'New workstream') : panel === 'person' ? 'Edit person' : (editingId ? 'Edit shared tag' : 'New shared tag');
  const updateItem = (next: ItemInput) => autofill.changeDraft(next);
  const changeStream = (next: WorkstreamInput) => { const previous = streamFormRef.current; const removed = previous?.goalIds.filter(id => !next.goalIds.includes(id)) ?? []; const textChanged = previous?.title !== next.title || previous?.description !== next.description; if (textChanged) next = { ...next, goalIds: next.goalIds.filter(id => !suggestedGoalIds.includes(id)) }; streamFormRef.current = next; setStreamForm(next); setDirty(true); suggestionSequence.current += 1; suggestionAbortRef.current?.abort(); suggestionAbortRef.current = null; setSuggestingGoals(false); setSuggestedGoalIds(ids => textChanged ? [] : ids.filter(id => next.goalIds.includes(id))); setManuallyRemovedGoalIds(ids => [...new Set([...ids.filter(id => !next.goalIds.includes(id)), ...removed])]); setGoalSuggestionError(null); setGoalSuggestionStatus(!assist.enabled ? 'unavailable' : autofill.enabled ? 'idle' : 'off'); };
  const suggestGoals = async () => {
    if (!streamForm || saving || !canEdit || !assist.enabled || !autofill.enabled) return;
    const sequence = ++suggestionSequence.current; const expectedRevision = snapshot.revision; const draft = { ...streamForm, goalIds: [...streamForm.goalIds] }; const controller = new AbortController(); suggestionAbortRef.current?.abort(); suggestionAbortRef.current = controller; setStreamResults([]); setSuggestedGoalIds([]); setSuggestingGoals(true); setGoalSuggestionStatus('pending'); setGoalSuggestionError(null);
    try {
      const response = await fetch('/api/work/assist/workstream', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: JSON.stringify({ expectedRevision, draft }) }); const parsed = assistResultSchema.parse(await responseJson<unknown>(response)); if (parsed.baseRevision !== expectedRevision) throw new Error('The workspace changed while suggestions were generated. Refresh and review before using them.'); const current = streamFormRef.current; if (sequence !== suggestionSequence.current || suggestionAbortRef.current !== controller || !current || JSON.stringify(current) !== JSON.stringify(draft)) return; setStreamResults([parsed]); const valid = new Set(snapshot.goals.map(goal => goal.id)); const additions = parsed.suggestions.filter(suggestion => suggestion.field === 'goalIds').map(suggestion => suggestion.value).filter(goalId => valid.has(goalId) && !current.goalIds.includes(goalId) && !manuallyRemovedGoalIds.includes(goalId)); if (additions.length) { const next = { ...current, goalIds: [...current.goalIds, ...additions] }; streamFormRef.current = next; setStreamForm(next); setDirty(true); setSuggestedGoalIds(ids => [...ids, ...additions]); setGoalSuggestionStatus('filled'); } else setGoalSuggestionStatus('empty');
    } catch (error) { if (sequence === suggestionSequence.current && suggestionAbortRef.current === controller && !(error instanceof DOMException && error.name === 'AbortError')) { setGoalSuggestionError(error instanceof Error ? error.message : 'Goal suggestions are unavailable.'); setGoalSuggestionStatus('error'); } } finally { if (suggestionAbortRef.current === controller) suggestionAbortRef.current = null; if (sequence === suggestionSequence.current) setSuggestingGoals(false); }
  };
  useEffect(() => {
    if (panel !== 'stream' || !streamForm) { streamTextKeyRef.current = null; streamDraftEditedRef.current = false; return; }
    const key = `${streamForm.title}\u0000${streamForm.description}`;
    const changed = streamTextKeyRef.current !== null && streamTextKeyRef.current !== key;
    if (streamTextKeyRef.current === null) streamTextKeyRef.current = key;
    else if (changed) { streamTextKeyRef.current = key; streamDraftEditedRef.current = true; }
    if (!streamForm.title.trim() || !canEdit || saving || !assist.enabled || !autofill.enabled || !streamDraftEditedRef.current) return;
    const timer = setTimeout(() => { void suggestGoals(); }, 650);
    return () => clearTimeout(timer);
  }, [assist.enabled, autofill.enabled, canEdit, panel, saving, streamForm?.description, streamForm?.title]);
  useEffect(() => { if (goalSuggestionStatus === 'filled' || goalSuggestionStatus === 'empty' || goalSuggestionStatus === 'error') streamDraftEditedRef.current = false; }, [goalSuggestionStatus]);
  if (!panel || panel === 'updates') return null;
  const itemEditor = itemForm ? <CommandForm labelledBy="work-panel-title" onSubmit={onSave}>
    {canEdit ? <AssistSurface available={assist.enabled && canEdit} autofill={autofill} /> : <p className="field-hint">Read-only access. You can review this work but cannot change it.</p>}
    <Field id="item-title" label="Title"><Input aria-required="true" autoFocus={!editingId} id="item-title" onBlur={autofill.completeTitle} onChange={event => updateItem({ ...itemForm, title: event.target.value })} placeholder="A clear, ordinary task" value={itemForm.title} /></Field>
    <Field id="item-description" label={<>Description <span className="field-optional">Optional</span></>}><Textarea id="item-description" onChange={event => updateItem({ ...itemForm, description: event.target.value })} placeholder="What needs to be true when this is done?" value={itemForm.description} /></Field>
    <Field id="item-due-date" label={<>Due date <span className="field-optional">Optional</span></>}><Input id="item-due-date" onChange={event => updateItem({ ...itemForm, dueDate: event.target.value || null })} type="date" value={itemForm.dueDate ?? ''} /></Field>
    <div className="field-grid item-meta-grid">
      <div className="field"><div className="field-label-row"><Label htmlFor="item-workstream">Workstream</Label><Provenance debug={autofill.debug} field="workstreamId" pending={autofill.status === 'pending'} results={autofill.results} value={itemForm.workstreamId} visible={autofill.suggestedWorkstream} /></div><Select value={itemForm.workstreamId || 'none'} onValueChange={value => { const parent = itemForm.parentId ? snapshot.items.find(candidate => candidate.id === itemForm.parentId) : null; updateItem({ ...itemForm, workstreamId: value === 'none' ? '' : value, parentId: parent && parent.workstreamId === value ? parent.id : null }); }}><SelectTrigger aria-label="Workstream" id="item-workstream"><SelectValue placeholder="Choose a workstream" /></SelectTrigger><SelectContent><SelectItem value="none">Choose a workstream</SelectItem>{snapshot.workstreams.map(stream => <SelectItem key={stream.id} value={stream.id}>{stream.title}</SelectItem>)}</SelectContent></Select></div>
      <Field id="item-status" label="Status"><Select value={itemForm.status} onValueChange={value => updateItem({ ...itemForm, status: value as Item['status'] })}><SelectTrigger aria-label="Status" id="item-status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todo">To do</SelectItem><SelectItem value="doing">In progress</SelectItem><SelectItem value="done">Done</SelectItem></SelectContent></Select></Field>
      <Field id="item-kind" label="Task type"><Select value={itemKind || 'main'} onValueChange={value => { const kind: ItemKind = value === 'main' || value === 'subtask' ? value : ''; setItemKind(kind); setDirty(true); if (kind === 'main' && itemForm.parentId) updateItem({ ...itemForm, parentId: null }); }}><SelectTrigger aria-label="Task type" aria-required="true" id="item-kind"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="main">Main task</SelectItem><SelectItem disabled={hasChildren} value="subtask">Subtask</SelectItem></SelectContent></Select></Field>
    </div>
    {itemKind === 'subtask' ? <Field id="item-parent" label="Parent task" hint={hasChildren ? 'A task with subtasks must remain a Main task.' : !itemForm.workstreamId ? 'Choose a workstream before selecting a parent.' : !parentCandidates.length ? 'No valid Main task is available in this workstream.' : 'Required for a Subtask; choose a Main task in the same workstream.'}><Select value={itemForm.parentId ?? 'none'} onValueChange={value => updateItem({ ...itemForm, parentId: value === 'none' ? null : value })}><SelectTrigger aria-label="Parent task" id="item-parent"><SelectValue placeholder="Choose a parent task" /></SelectTrigger><SelectContent><SelectItem value="none">Choose a parent task</SelectItem>{parentCandidates.map(parent => <SelectItem key={parent.id} value={parent.id}>{parent.title}</SelectItem>)}</SelectContent></Select></Field> : null}
    <AssigneePicker people={snapshot.people} selectedIds={itemForm.assigneeIds} onChange={assigneeIds => updateItem({ ...itemForm, assigneeIds })} />
    <div className="field contextual-goals"><span className="field-label">Contextual goals</span>{linkedGoals.length ? <ul className="contextual-goal-list">{linkedGoals.map(goal => <li key={goal.id}>{goal.title}</li>)}</ul> : <p className="field-hint">No goals are linked to this workstream.</p>}</div>
    <div className="field"><span className="field-label">Shared tags</span><div className="tag-picker">{availableTags.map(tag => { const selected = itemForm.tagIds.includes(tag.id); const aiOwned = selected && autofill.suggestedTagIds.includes(tag.id); return <div className="tag-option" key={tag.id}><Button aria-label={`${selected ? 'Remove' : 'Add'} tag ${tag.name}${aiOwned ? ', suggested by Goalie' : ''}`} aria-pressed={selected} className={`tag-toggle ${selected ? 'selected' : ''}`} onClick={() => updateItem({ ...itemForm, tagIds: selected ? itemForm.tagIds.filter(id => id !== tag.id) : [...itemForm.tagIds, tag.id] })} size="sm" type="button" variant="outline">{tag.name}</Button>{aiOwned ? <Provenance debug={autofill.debug} field="tagIds" pending={autofill.status === 'pending'} results={autofill.results} value={tag.id} visible /> : null}</div>; })}</div>{snapshot.tags.length === 0 ? <p className="field-hint">No shared tags have been defined.</p> : null}</div>
    <div className="panel-actions">{canDelete && editingId ? <Button disabled={saving} onClick={onDelete} type="button" variant="destructive"><Trash2 aria-hidden="true" />Delete</Button> : null}<Button disabled={saving || !canEdit || !itemKind || !itemForm.title.trim() || !itemForm.workstreamId || (itemKind === 'subtask' && !itemForm.parentId)} type="submit">{saving ? <LoaderCircle className="spin" /> : null}{editingId ? 'Save changes' : 'Create work'}</Button><Button disabled={saving} onClick={onClose} type="button" variant="outline">Cancel</Button></div>
  </CommandForm> : null;
  return <Dialog open={Boolean(panel)} modal={compact && !confirmationOpen} onOpenChange={open => { if (!open) onClose(); }}><DialogContent aria-describedby={undefined} aria-label={panelTitle} data-no-overlay={!compact} className={`work-panel ${compact ? 'work-panel-sheet' : 'work-panel-desktop'}`} onInteractOutside={event => event.preventDefault()} onEscapeKeyDown={event => { const target = event.target instanceof Element ? event.target : null; const score = target?.closest<HTMLDetailsElement>('.provenance-details[open]'); if (score) { event.preventDefault(); score.open = false; score.querySelector('summary')?.focus(); return; } const picker = target?.closest<HTMLDetailsElement>('.assignee-picker[open]'); if (!picker) return; event.preventDefault(); picker.open = false; picker.querySelector('summary')?.focus(); }} onCloseAutoFocus={event => restoreEditorFocus(event, openerRef.current)}><><div className="panel-heading"><div><DialogTitle id="work-panel-title">{panelTitle}</DialogTitle>{dirty ? <span className="panel-draft-status">Unsaved changes</span> : null}</div><Button aria-label="Close editor" disabled={saving} onClick={onClose} size="icon" variant="ghost"><X /></Button></div><fieldset disabled={saving || (!canEdit && panel !== 'person')} className="contents">{actionError ? <Alert variant="destructive" className="error-banner"><CircleAlert aria-hidden="true" /><AlertDescription>{actionError.message}</AlertDescription></Alert> : null}
    {panel === 'item' ? itemEditor : null}
    {panel === 'person' && personForm && editingId ? <CommandForm labelledBy="work-panel-title" onSubmit={onSave}><Field id="person-name" label="Name"><Input aria-required="true" autoFocus id="person-name" onChange={event => { setPersonForm({ ...personForm, name: event.target.value }); setDirty(true); }} value={personForm.name} /></Field><Field id="person-email" label="Email" hint="Email is immutable after creation."><Input aria-required="true" id="person-email" disabled type="email" value={personForm.email} /></Field><Field id="person-role" label="Access role"><Select value={personForm.role} onValueChange={value => { setPersonForm({ ...personForm, role: value as PersonInput['role'] }); setDirty(true); }}><SelectTrigger aria-label="Access role" id="person-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="admin">Admin — manage people</SelectItem><SelectItem value="editor">Editor — manage work</SelectItem><SelectItem value="viewer">Viewer — read-only</SelectItem></SelectContent></Select></Field><div className="panel-actions"><Button disabled={saving || !isAdmin || !personForm.name.trim()} type="submit">{saving ? <LoaderCircle className="spin" /> : null}Save person</Button><Button disabled={saving} onClick={onClose} type="button" variant="outline">Cancel</Button></div></CommandForm> : null}
    {panel === 'goal' && goalForm ? <CommandForm labelledBy="work-panel-title" onSubmit={onSave}><Field id="goal-title" label="Title"><Input aria-required="true" autoFocus={!editingId} id="goal-title" onChange={event => { setGoalForm({ ...goalForm, title: event.target.value }); setDirty(true); }} value={goalForm.title} /></Field><Field id="goal-description" label="Description"><Textarea id="goal-description" onChange={event => { setGoalForm({ ...goalForm, description: event.target.value }); setDirty(true); }} value={goalForm.description} /></Field><Field id="goal-target-date" label="Target date"><Input id="goal-target-date" onChange={event => { setGoalForm({ ...goalForm, targetDate: event.target.value || null }); setDirty(true); }} type="date" value={goalForm.targetDate ?? ''} /></Field><div className="panel-actions">{canDelete && editingId ? <Button disabled={saving} onClick={onDelete} type="button" variant="destructive"><Trash2 aria-hidden="true" />Delete</Button> : null}<Button disabled={saving || !canEdit || !goalForm.title.trim()} type="submit">{saving ? <LoaderCircle className="spin" /> : null}{editingId ? 'Save changes' : 'Create goal'}</Button><Button disabled={saving} onClick={onClose} type="button" variant="outline">Cancel</Button></div></CommandForm> : null}
    {panel === 'stream' && streamForm ? canEdit ? <AssistSurface available={assist.enabled} autofill={autofill} scope="stream" status={suggestingGoals ? 'pending' : goalSuggestionStatus} error={goalSuggestionError} onRetry={() => { void suggestGoals(); }} /> : <p className="field-hint">Read-only access. You can review this workstream but cannot change it.</p> : null}
    {panel === 'stream' && streamForm ? <CommandForm labelledBy="work-panel-title" onSubmit={onSave}>
      <Field id="stream-title" label="Title"><Input aria-required="true" autoFocus={!editingId} id="stream-title" onChange={event => changeStream({ ...streamForm, title: event.target.value })} value={streamForm.title} /></Field>
      <Field id="stream-description" label="Description"><Textarea id="stream-description" onChange={event => changeStream({ ...streamForm, description: event.target.value })} value={streamForm.description} /></Field>
      <Field id="stream-lead" label="Lead"><Select value={streamForm.leadId ?? 'none'} onValueChange={value => changeStream({ ...streamForm, leadId: value === 'none' ? null : value })}><SelectTrigger aria-label="Lead" id="stream-lead"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No lead</SelectItem>{snapshot.people.map(person => <SelectItem key={person.id} value={person.id}>{person.name}</SelectItem>)}</SelectContent></Select></Field>
      <div className="field"><span className="field-label">Linked goals</span><div className="check-list" aria-label="Workstream linked goals">{snapshot.goals.map(goal => <div className="check-row" key={goal.id}><Label htmlFor={`stream-goal-${goal.id}`}><Checkbox checked={streamForm.goalIds.includes(goal.id)} id={`stream-goal-${goal.id}`} onCheckedChange={checked => { if (checked) { changeStream({ ...streamForm, goalIds: [...streamForm.goalIds, goal.id] }); setSuggestedGoalIds(ids => ids.filter(id => id !== goal.id)); setManuallyRemovedGoalIds(ids => ids.filter(id => id !== goal.id)); } else { changeStream({ ...streamForm, goalIds: streamForm.goalIds.filter(id => id !== goal.id) }); setSuggestedGoalIds(ids => ids.filter(id => id !== goal.id)); setManuallyRemovedGoalIds(ids => [...new Set([...ids, goal.id])]); } }} /><span>{goal.title}</span></Label>{suggestedGoalIds.includes(goal.id) ? <Provenance debug={autofill.debug} field="goalIds" pending={goalSuggestionStatus === 'pending'} results={streamResults} value={goal.id} visible /> : null}</div>)}</div></div>
      <div className="panel-actions">{canDelete && editingId ? <Button disabled={saving} onClick={onDelete} type="button" variant="destructive"><Trash2 aria-hidden="true" />Delete</Button> : null}<Button disabled={saving || !canEdit || !streamForm.title.trim()} type="submit">{saving ? <LoaderCircle className="spin" /> : null}{editingId ? 'Save changes' : 'Create workstream'}</Button><Button disabled={saving} onClick={onClose} type="button" variant="outline">Cancel</Button></div>
    </CommandForm> : null}
    {panel === 'tag' && tagForm ? <CommandForm labelledBy="work-panel-title" onSubmit={onSave}><Field id="tag-name" label="Name"><Input aria-required="true" autoFocus={!editingId} id="tag-name" onBlur={() => setDirty(true)} onChange={event => { setTagForm({ ...tagForm, name: event.target.value }); setDirty(true); }} value={tagForm.name} /></Field><Field id="tag-description" label="Description"><Textarea aria-required="true" id="tag-description" onChange={event => { setTagForm({ ...tagForm, description: event.target.value }); setDirty(true); }} value={tagForm.description} /></Field><Field id="tag-workstream" label="Workstream scope" hint="Common tags can only be managed by an admin."><Select value={tagForm.workstreamId ?? 'none'} onValueChange={value => { setTagForm({ ...tagForm, workstreamId: value === 'none' ? null : value }); setDirty(true); }}><SelectTrigger aria-label="Workstream scope" id="tag-workstream"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Common</SelectItem>{snapshot.workstreams.map(stream => <SelectItem key={stream.id} value={stream.id}>{stream.title}</SelectItem>)}</SelectContent></Select></Field><div className="panel-actions">{canDelete && editingId ? <Button disabled={saving} onClick={onDelete} type="button" variant="destructive"><Trash2 aria-hidden="true" />Delete</Button> : null}<Button disabled={saving || !tagWritable || !tagForm.name.trim() || !tagForm.description.trim()} type="submit">{saving ? <LoaderCircle className="spin" /> : null}{editingId ? 'Save changes' : 'Create tag'}</Button><Button disabled={saving} onClick={onClose} type="button" variant="outline">Cancel</Button></div></CommandForm> : null}
  </fieldset></></DialogContent></Dialog>;
}

function AssessmentControls({ assessment, canEdit, paused, pendingCount, onRefresh, snapshot, actorId, currentView, viewScope }: { assessment: UseWorkAssessmentsResult; canEdit: boolean; paused: boolean; pendingCount: number; onRefresh: () => void; snapshot: Snapshot; actorId: string; currentView: Filters; viewScope: WorkScope }) {
  const [changing, setChanging] = useState(false);
  const [editingScope, setEditingScope] = useState(false);
  const on = assessment.enabled && !assessment.locallyStopped;
  const toggle = async () => {
    setChanging(true);
    try { await assessment.setEnabled(!assessment.enabled); } finally { setChanging(false); }
  };
  return <><section className="assessment-controls" aria-labelledby="assessment-controls-title"><div><div className="assessment-control-heading"><h2 id="assessment-controls-title"><Sparkles aria-hidden="true" />Goalie Suggestions</h2><Button aria-label="Choose work for Goalie" disabled={!canEdit || assessment.savingScope} onClick={() => setEditingScope(true)} size="sm" type="button" variant="outline">{assessment.scope ? 'Edit scope' : 'Choose scope'}</Button></div><p className="assessment-scope-summary">{scopeSummary(assessment.scope, snapshot)}</p></div><Button aria-label={assessment.enabled ? 'Turn off Goalie Suggestions' : 'Turn on Goalie Suggestions'} aria-pressed={on} disabled={changing || assessment.loading || assessment.savingScope || (!assessment.enabled && (Boolean(assessment.scopeError) || !canEdit || !assessment.provider.enabled || !assessment.scope))} onClick={() => { void toggle(); }} type="button" variant={on ? 'default' : 'outline'}>{changing ? 'Saving…' : on ? 'On' : 'Off'}</Button>{assessment.scopeError ? <p className="assessment-status" role="alert">{assessment.scopeError} Save scope successfully before enabling.</p> : null}{assessment.loading ? <p className="assessment-status">Loading assessment state…</p> : null}{assessment.locallyStopped ? <p className="assessment-status" role="alert">Assessments are stopped in this tab. Retry Off to confirm it, or explicitly turn On again.</p> : null}{assessment.pausedError ? <div className="assessment-status"><span role="alert">Assessments paused: {assessment.pausedError}</span>{canEdit && assessment.enabled && !assessment.locallyStopped ? <Button onClick={assessment.resume} size="sm" type="button" variant="outline">Resume assessments</Button> : null}</div> : null}{assessment.refreshRequiredIds.size ? <div className="assessment-status"><span>Refresh shared work to assess current data.</span><Button onClick={onRefresh} size="sm" type="button" variant="outline">Refresh shared work</Button></div> : null}{canEdit && on && paused ? <p className="assessment-status">Assessments paused while changes are unsaved or shared work is loading.</p> : canEdit && on && !assessment.pausedError && pendingCount > 0 ? <p className="assessment-status" role="status">Assessing {pendingCount} work items; AI filters apply as results arrive</p> : null}{!canEdit ? <p className="field-hint">Viewer access can inspect shared assessments; only editors and administrators can enable them.</p> : null}</section>{editingScope ? <ScopeEditor actorId={actorId} assessment={assessment} currentView={currentView} viewScope={viewScope} onClose={() => setEditingScope(false)} snapshot={snapshot} /> : null}</>;
}

export default function WorkRoute() {
  const initial = useLoaderData<typeof loader>();
  const [snapshot, setSnapshot] = useState<Snapshot>(initial.data);
  const [section, setSection] = useState<Section>('work');
  const [scope, setScope] = useState<WorkScope>('all');
  const [panel, setPanel] = useState<Panel>(null);
  const [assessmentOpenRequest, setAssessmentOpenRequest] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [itemForm, setItemForm] = useState<ItemInput | null>(null);
  const [itemKind, setItemKind] = useState<ItemKind>('');
  const [goalForm, setGoalForm] = useState<GoalInput | null>(null);
  const [streamForm, setStreamForm] = useState<WorkstreamInput | null>(null);
  const [filters, setFilters] = useState<Filters>(() => ({ ...DEFAULT_WORK_FILTERS, assessmentDecisions: [] }));
  const [tagForm, setTagForm] = useState<TagInput | null>(null);
  const [personForm, setPersonForm] = useState<PersonInput | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [actionError, setActionError] = useState<AppError | null>(null);
  const [updateBody, setUpdateBody] = useState('');
  const [updateKind, setUpdateKind] = useState<UpdateKind>('note');
  const [mobileNav, setMobileNav] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [pendingAction, setPendingAction] = useState<(() => void) | null>(null);
  const [pendingPersonCommand, setPendingPersonCommand] = useState<PendingPersonCommand | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [editingUpdateId, setEditingUpdateId] = useState<string | null>(null);
  const [editingUpdateBody, setEditingUpdateBody] = useState('');
  const [theme, setTheme] = useState<ThemePreference>('system');
  const [editorSession, setEditorSession] = useState(0);
  const actor = snapshot.people.find(person => person.id === initial.user.id) ?? initial.user;
  const [currentAssist, setCurrentAssist] = useState<AssistStatus>(initial.assist);
  const [personalAIEnabled, setPersonalAIEnabled] = useState(false);
  const aiPreferenceKey = `goalie:work-ai:${actor.id}`;
  const [aiPreferenceLoadedKey, setAiPreferenceLoadedKey] = useState<string | null>(null);
  useEffect(() => {
    let enabled = false;
    try { enabled = window.localStorage.getItem(aiPreferenceKey) === '1'; } catch { /* storage can be unavailable */ }
    setPersonalAIEnabled(enabled);
    setAiPreferenceLoadedKey(aiPreferenceKey);
  }, [aiPreferenceKey]);
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== aiPreferenceKey) return;
      setPersonalAIEnabled(event.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [aiPreferenceKey]);
  const aiAvailable = currentAssist.enabled;
  const effectiveAssist = personalAIEnabled && aiAvailable;
  const changePersonalAI = useCallback((next: boolean) => {
    if (!aiAvailable || aiPreferenceLoadedKey !== aiPreferenceKey) return;
    setPersonalAIEnabled(next);
    try { window.localStorage.setItem(aiPreferenceKey, next ? '1' : '0'); } catch { /* storage can be unavailable */ }
  }, [aiAvailable, aiPreferenceKey, aiPreferenceLoadedKey]);
  const canEdit = actor.role !== 'viewer';
  const isAdmin = actor.role === 'admin';
  const canManageTag = canEdit && (isAdmin || snapshot.workstreams.some(stream => stream.leadId === actor.id));
  const canEditTag = (tag: Tag) => isAdmin || Boolean(tag.workstreamId && snapshot.workstreams.some(stream => stream.id === tag.workstreamId && stream.leadId === actor.id));
  const tagWritable = Boolean(editingId && snapshot.tags.some(tag => tag.id === editingId && canEditTag(tag)));
  const selectedItemHasChildren = Boolean(editingId && snapshot.items.some(child => child.parentId === editingId));
  const visibleTitle = useMemo(() => section === 'work' ? (scope === 'mine' ? 'My work' : 'All work') : section === 'goals' ? 'Goals' : section === 'streams' ? 'Workstreams' : section === 'people' ? 'People' : 'Shared tags', [scope, section]);
  const hasUnsaved = dirty || Boolean(updateBody.trim()) || Boolean(editingUpdateId);
  const guardBypassRef = useRef(false);
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const selectCandidateIds = useCallback((asOf: string | null) => snapshot.items.filter(item => matchesBaseWorkFilters(item, snapshot, filters, scope, actor.id, asOf)).map(item => item.id), [actor.id, filters, scope, snapshot]);
  const assessments = useWorkAssessments({ actor, available: effectiveAssist, csrfToken: initial.csrfToken, pausedForEditing: hasUnsaved || saving || refreshing, selectCandidateIds, signingOut, snapshot, updatesItemId: panel === 'updates' ? editingId : null, workViewActive: section === 'work' });
  const matchingIds = useMemo(() => new Set(assessments.candidateIds.filter(itemId => {
    if (!effectiveAssist || !filters.assessmentDecisions.length) return true;
    const item = snapshot.items.find(candidate => candidate.id === itemId);
    if (!item || item.status === 'done') return false;
    if (assessments.scope && !assessments.scopeItemIds.has(itemId)) return false;
    const entry = assessments.entriesByItemId.get(itemId);
    if (!entry || entry.state !== 'current' || !entry.assessment || assessments.pendingIds.has(itemId) || assessments.refreshRequiredIds.has(itemId) || assessments.errorsByItemId.has(itemId)) return false;
    return filters.assessmentDecisions.includes(entry.assessment.labels.decision);
  })), [assessments.candidateIds, assessments.entriesByItemId, assessments.pendingIds, assessments.refreshRequiredIds, assessments.errorsByItemId, assessments.scope, assessments.scopeItemIds, effectiveAssist, filters.assessmentDecisions, snapshot.items]);
  const toggleFilter = useCallback((filter: BadgeFilter) => {
    setFilters(previous => {
      const values = previous[filter.key] as string[];
      const nextValues = values.includes(filter.value) ? values.filter(value => value !== filter.value) : [...values, filter.value];
      return { ...previous, [filter.key]: nextValues };
    });
  }, []);
  const pendingAssessmentCount = assessments.runCandidateIds.filter(id => snapshot.items.some(item => item.id === id && item.status !== 'done') && assessments.entriesByItemId.get(id)?.state !== 'current' && !assessments.errorsByItemId.has(id) && !assessments.refreshRequiredIds.has(id)).length;

  const applyTheme = useCallback((preference: ThemePreference) => {
    const dark = preference === 'dark' || (preference === 'system' && typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    try { localStorage.setItem('goalie-theme', preference); } catch { /* storage can be unavailable in hardened browsers */ }
    setTheme(preference);
  }, []);
  useEffect(() => { const preference = document.documentElement.dataset.themePreference; if (preference === 'light' || preference === 'dark' || preference === 'system') setTheme(preference); else applyTheme('system'); }, [applyTheme]);
  useEffect(() => { if (theme !== 'system') return; const media = window.matchMedia('(prefers-color-scheme: dark)'); const update = () => applyTheme('system'); media.addEventListener('change', update); return () => media.removeEventListener('change', update); }, [applyTheme, theme]);

  const autofill = useWorkAutofill({ draft: itemForm, setDraft: setItemForm, setDirty, snapshot, editorSession, active: panel === 'item', canEdit, saving, csrfToken: initial.csrfToken, available: effectiveAssist, model: currentAssist.model });
  useEffect(() => { if (aiAvailable) autofill.setEnabled(personalAIEnabled); }, [aiAvailable, autofill.setEnabled, personalAIEnabled]);
  const discardEditor = useCallback(() => { setPanel(null); setEditingId(null); setSelectedId(null); setItemForm(null); setItemKind(''); setGoalForm(null); setStreamForm(null); setTagForm(null); setPersonForm(null); setDirty(false); setUpdateBody(''); setUpdateKind('note'); setEditingUpdateId(null); setEditingUpdateBody(''); }, [])
  const confirmNavigation = (action: () => void) => { if (saving || refreshing) return false; if (guardBypassRef.current || !hasUnsaved) return true; setPendingAction(() => action); return false; };
  useEffect(() => { const beforeUnload = (event: BeforeUnloadEvent) => { if (!hasUnsaved) return; event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload); }, [hasUnsaved]);

  const refreshData = useCallback(async () => {
    if (saving || refreshing) return;
    if (hasUnsaved && !guardBypassRef.current) { setPendingAction(() => () => { void refreshData(); }); return; }
    discardEditor(); setRefreshing(true); setActionError(null);
    try { const response = await fetch('/api/work', { credentials: 'same-origin' }); const body = await responseJson<{ data: Snapshot; assist?: unknown }>(response); const nextAssist = parseAssistStatus(body.assist); if (nextAssist) setCurrentAssist(nextAssist); setSnapshot(body.data); if (body.data.revision === snapshot.revision) await assessments.refresh(); } catch (error) { setActionError(error instanceof Error ? error as AppError : requestError('The shared work could not be refreshed.')); } finally { setRefreshing(false); }
  }, [assessments.refresh, discardEditor, hasUnsaved, refreshing, saving, snapshot.revision]);
  const runCommand = useCallback(async (command: Command, options: CommandOptions = {}) => {
    if (saving || refreshing) return null;
    setSaving(true); setActionError(null);
    try { const response = await fetch('/api/work', { body: JSON.stringify({ expectedRevision: snapshot.revision, command }), credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': initial.csrfToken }, method: 'POST' }); const body = await responseJson<{ data: Snapshot; assist?: unknown }>(response); const nextAssist = parseAssistStatus(body.assist); if (nextAssist) setCurrentAssist(nextAssist); if (options.starOnly) setSnapshot(previous => ({ ...previous, starredItemIds: body.data.starredItemIds })); else setSnapshot(body.data); if (!options.preserveDirty) setDirty(false); if (options.closePanel !== false && !updateBody.trim()) discardEditor(); return body.data; } catch (error) { const typed = error instanceof Error ? error as AppError : requestError('The server could not complete that change.'); setActionError(typed); return null; } finally { setSaving(false); }
  }, [discardEditor, initial.csrfToken, refreshing, saving, snapshot.revision, updateBody]);
  const openItem = (item?: Item, context?: ItemCreationContext, opener?: HTMLElement | null) => {
    if (!confirmNavigation(() => openItem(item, context, opener))) return;
    let prefill: ItemInput;
    let nextKind: ItemKind;
    if (item) {
      prefill = itemInput(item);
      nextKind = item.parentId ? 'subtask' : 'main';
    } else if (context?.parentId) {
      const parent = snapshot.items.find(candidate => candidate.id === context.parentId);
      const stream = parent ? snapshot.workstreams.find(candidate => candidate.id === parent.workstreamId) : null;
      if (!parent || parent.parentId !== null || parent.status === 'done' || !stream) { setActionError(requestError('That parent is unavailable or completed. Reopen it before adding a subtask.')); return; }
      prefill = { ...emptyItem(stream.id), parentId: parent.id };
      nextKind = 'subtask';
    } else if (context?.workstreamId) {
      if (!snapshot.workstreams.some(stream => stream.id === context.workstreamId)) { setActionError(requestError('That workstream is no longer available. Refresh and try again.')); return; }
      prefill = emptyItem(context.workstreamId);
      nextKind = 'main';
    } else {
      if (!snapshot.workstreams.length) { setActionError(requestError('Create a workstream before adding work.')); return; }
      const validSelectedStreams = filters.workstreamIds.filter(id => snapshot.workstreams.some(stream => stream.id === id));
      const preselectedWorkstream = validSelectedStreams.length === 1 ? validSelectedStreams[0] : snapshot.workstreams.length === 1 ? snapshot.workstreams[0].id : '';
      prefill = emptyItem(preselectedWorkstream);
      nextKind = 'main';
    }
    editorOpenerRef.current = opener ?? document.activeElement as HTMLElement | null;
    setEditorSession(session => session + 1); setActionError(null); setPanel('item'); setEditingId(item?.id ?? null); setSelectedId(item?.id ?? null); setItemForm(prefill); setItemKind(nextKind); setGoalForm(null); setStreamForm(null); setTagForm(null); setPersonForm(null); setDirty(false); if (!updateBody.trim()) setUpdateBody('');
  };
  const openUpdates = (item: Item, inspect = false, opener?: HTMLElement | null) => { if (!confirmNavigation(() => openUpdates(item, inspect, opener))) return; editorOpenerRef.current = opener ?? document.activeElement as HTMLElement | null; setActionError(null); setAssessmentOpenRequest(inspect ? request => request + 1 : 0); setPanel('updates'); setEditingId(item.id); setSelectedId(item.id); setItemForm(null); setItemKind(''); setGoalForm(null); setStreamForm(null); setTagForm(null); setPersonForm(null); setUpdateKind('note'); setEditingUpdateId(null); setEditingUpdateBody(''); setDirty(false); };
  const openGoal = (goal?: Goal, opener?: HTMLElement | null) => { if (!confirmNavigation(() => openGoal(goal, opener))) return; editorOpenerRef.current = opener ?? document.activeElement as HTMLElement | null; setActionError(null); setPanel('goal'); setEditingId(goal?.id ?? null); setGoalForm(goal ? { title: goal.title, description: goal.description, targetDate: goal.targetDate } : emptyGoal()); setItemForm(null); setItemKind(''); setStreamForm(null); setTagForm(null); setPersonForm(null); setDirty(false); };
  const openStream = (stream?: Workstream, context?: StreamCreationContext, opener?: HTMLElement | null) => { if (!confirmNavigation(() => openStream(stream, context, opener))) return; let form = stream ? { title: stream.title, description: stream.description, leadId: stream.leadId, goalIds: stream.goalIds } : emptyStream(); if (!stream && context?.goalId) { const goal = snapshot.goals.find(candidate => candidate.id === context.goalId); if (!goal) { setActionError(requestError('That goal is no longer available. Refresh and try again.')); return; } form = { ...form, goalIds: [goal.id] }; } editorOpenerRef.current = opener ?? document.activeElement as HTMLElement | null; setEditorSession(session => session + 1); setActionError(null); setPanel('stream'); setEditingId(stream?.id ?? null); setStreamForm(form); setItemForm(null); setItemKind(''); setGoalForm(null); setTagForm(null); setPersonForm(null); setDirty(false); };
  const openTag = (tag?: Tag, opener?: HTMLElement | null) => { if (!confirmNavigation(() => openTag(tag, opener))) return; const allowed = isAdmin || Boolean(tag?.workstreamId && snapshot.workstreams.some(stream => stream.id === tag.workstreamId && stream.leadId === actor.id)) || (!tag && canManageTag); if (!allowed) { setActionError(requestError('Only an admin or the workstream lead can manage this tag.', 403, 'forbidden')); return; } const leadStreamId = snapshot.workstreams.find(stream => stream.leadId === actor.id)?.id ?? null; editorOpenerRef.current = opener ?? document.activeElement as HTMLElement | null; setActionError(null); setPanel('tag'); setEditingId(tag?.id ?? null); setTagForm(tag ? { name: tag.name, description: tag.description, workstreamId: tag.workstreamId } : { ...emptyTag(), workstreamId: isAdmin ? null : leadStreamId }); setItemForm(null); setItemKind(''); setGoalForm(null); setStreamForm(null); setPersonForm(null); setDirty(false); };
  const openPerson = (person: Person, opener?: HTMLElement | null) => { if (!isAdmin) { setActionError(requestError('Only an admin can manage people.', 403, 'forbidden')); return; } if (!confirmNavigation(() => openPerson(person, opener))) return; editorOpenerRef.current = opener ?? document.activeElement as HTMLElement | null; setActionError(null); setPanel('person'); setEditingId(person.id); setPersonForm({ name: person.name, email: person.email, role: person.role }); setItemForm(null); setItemKind(''); setGoalForm(null); setStreamForm(null); setTagForm(null); setDirty(false); };
  const closePanel = () => { if (!confirmNavigation(() => closePanel())) return; discardEditor(); setActionError(null); };
  const requestDelete = () => {
    if (!editingId || saving || panel === null || panel === 'updates' || panel === 'person') return;
    const record = panel === 'item' ? snapshot.items.find(candidate => candidate.id === editingId) : panel === 'goal' ? snapshot.goals.find(candidate => candidate.id === editingId) : panel === 'stream' ? snapshot.workstreams.find(candidate => candidate.id === editingId) : snapshot.tags.find(candidate => candidate.id === editingId);
    if (!record) return;
    const title = 'title' in record ? record.title : record.name;
    const command = panel === 'item' ? { type: 'item.delete' as const, id: editingId } : panel === 'goal' ? { type: 'goal.delete' as const, id: editingId } : panel === 'stream' ? { type: 'workstream.delete' as const, id: editingId } : { type: 'tag.delete' as const, id: editingId };
    setPendingDelete({ command: command as Command, entity: panel === 'stream' ? 'workstream' : panel, title: `Delete ${title}?`, description: `Delete ${title}? This cannot be undone. Related records are not deleted; if this record is still referenced, the server will explain what must be resolved first.` });
  };
  const requestDeleteUpdate = (id: string) => { const update = snapshot.updates.find(record => record.id === id); if (!update || saving) return; const label = update.kind === 'blocker' ? 'blocker raised' : update.kind === 'blocker_resolved' ? 'blocker resolution' : 'note'; const draftMessage = editingUpdateId && editingUpdateId !== id ? ' Your other timeline edit and any new-entry draft will be kept.' : updateBody.trim() ? ' Your new-entry draft will be kept.' : ''; setPendingDelete({ command: { type: 'update.delete', id } as Command, entity: 'update', title: `Delete ${label}?`, description: `Delete this ${label}? This cannot be undone.${draftMessage}` }); };
  const editUpdate = (id: string, body: string) => { if (!confirmNavigation(() => editUpdate(id, body))) return; setEditingUpdateId(id); setEditingUpdateBody(body); };
  const saveUpdate = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!editingUpdateId || !editingUpdateBody.trim() || saving) return; const result = await runCommand({ type: 'update.edit', id: editingUpdateId, body: editingUpdateBody.trim() } as Command, { closePanel: false, preserveDirty: true }); if (result) { setEditingUpdateId(null); setEditingUpdateBody(''); } };
  const cancelUpdate = () => { setEditingUpdateId(null); setEditingUpdateBody(''); };
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (panel === 'item' && itemForm) {
      if (!itemKind) { setActionError(requestError('Choose Main task or Subtask before saving.')); return; }
      const parent = itemForm.parentId ? snapshot.items.find(candidate => candidate.id === itemForm.parentId) : null;
      if (itemKind === 'main' && itemForm.parentId) { setActionError(requestError('Main tasks cannot have a parent.')); return; }
      if (itemKind === 'subtask' && (!parent || parent.parentId !== null || parent.workstreamId !== itemForm.workstreamId || parent.id === editingId)) { setActionError(requestError('Choose a valid Main task parent in the same workstream.')); return; }
      if (itemKind === 'subtask' && selectedItemHasChildren) { setActionError(requestError('A task with subtasks must remain a Main task.')); return; }
      const allowedTagIds = new Set(snapshot.tags.filter(tag => !tag.workstreamId || tag.workstreamId === itemForm.workstreamId).map(tag => tag.id));
      if (itemForm.tagIds.some(tagId => !allowedTagIds.has(tagId))) { setActionError(requestError('Remove tags scoped to another workstream before saving.')); return; }
      await runCommand(editingId ? { type: 'item.update', id: editingId, item: itemForm } : { type: 'item.create', item: itemForm });
    }
    if (panel === 'goal' && goalForm) await runCommand(editingId ? { type: 'goal.update', id: editingId, goal: goalForm } : { type: 'goal.create', goal: goalForm });
    if (panel === 'stream' && streamForm) await runCommand(editingId ? { type: 'workstream.update', id: editingId, workstream: streamForm } : { type: 'workstream.create', workstream: streamForm });
    if (panel === 'tag' && tagForm) await runCommand(editingId ? { type: 'tag.update', id: editingId, tag: tagForm } : { type: 'tag.create', tag: tagForm });
    if (panel === 'person' && personForm && editingId) {
      if (!personForm.name.trim() || !personForm.email.trim()) { setActionError(requestError('Name is required.')); return; }
      const existing = snapshot.people.find(person => person.id === editingId);
      if (!existing) { setActionError(requestError('That person is no longer available. Refresh and try again.')); return; }
      const command = { type: 'person.update' as const, id: editingId, person: personForm };
      setPendingPersonCommand({ command, title: `Confirm updating ${existing.name}`, description: `Update ${existing.name} (${existing.email}) to name ${personForm.name}, role ${existing.role} → ${personForm.role}?` });
    }
  };
  const resolveBlocker = async () => { const persisted = snapshot.items.find(item => item.id === editingId); if (!persisted || saving || !canEdit || !persisted.blocker) return; await runCommand({ type: 'update.add', itemId: persisted.id, kind: 'blocker_resolved', body: 'Resolved current blocker' }, { closePanel: false, preserveDirty: true }); };
  const addUpdate = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const persisted = editingId ? snapshot.items.find(item => item.id === editingId) : null; if (!editingId || !updateBody.trim() || !persisted || saving) return; const result = await runCommand({ type: 'update.add', itemId: editingId, kind: updateKind, body: updateBody.trim() }, { closePanel: false, preserveDirty: true }); if (result) setUpdateBody(''); };
  const toggleStar = async (item: Item) => { if (saving || refreshing) return; const starred = snapshot.starredItemIds.includes(item.id); await runCommand({ type: 'item.star', itemId: item.id, starred: !starred }, { closePanel: false, preserveDirty: true, starOnly: true }); };
  const confirmPersonCommand = async () => { const pending = pendingPersonCommand; if (!pending) return; setPendingPersonCommand(null); await runCommand(pending.command); };
  const confirmDelete = async () => {
    const pending = pendingDelete;
    if (!pending || saving) return;
    setPendingDelete(null);
    const result = await runCommand(pending.command, { closePanel: false, preserveDirty: true });
    if (!result) return;
    if (pending.entity === 'update') { if (pending.command.type === 'update.delete' && pending.command.id === editingUpdateId) cancelUpdate(); return; }
    const deletedId = 'id' in pending.command ? pending.command.id : null;
    setFilters(previous => ({ ...previous, ...(deletedId && pending.entity === 'goal' ? { goalIds: previous.goalIds.filter(id => id !== deletedId) } : deletedId && pending.entity === 'workstream' ? { workstreamIds: previous.workstreamIds.filter(id => id !== deletedId) } : deletedId && pending.entity === 'tag' ? { tagIds: previous.tagIds.filter(id => id !== deletedId) } : {}) }));
    discardEditor();
  };
  const changeSection = (next: Section) => { if (!confirmNavigation(() => changeSection(next))) return; setSection(next); setMobileNav(false); window.scrollTo(0, 0); };
  const changeScope = (next: WorkScope) => { if (!confirmNavigation(() => changeScope(next))) return; setScope(next); setSection('work'); setMobileNav(false); window.scrollTo(0, 0); };
  const signOut = async () => { if (saving || refreshing) return; if (!guardBypassRef.current && hasUnsaved) { setPendingAction(() => () => { void signOut(); }); return; } setSigningOut(true); try { const response = await fetch('/auth/logout', { credentials: 'same-origin', headers: { 'X-CSRF-Token': initial.csrfToken }, method: 'POST', redirect: 'manual' }); if (!(response.type === 'opaqueredirect' || response.ok)) throw requestError('Sign out could not be completed.', response.status, 'logout_failed'); discardEditor(); window.location.assign('/'); } catch (error) { setSigningOut(false); setActionError(error instanceof Error ? error as AppError : requestError('Sign out could not be completed.')); } };
  const confirmDiscard = () => { const action = pendingAction; if (!action) return; setPendingAction(null); discardEditor(); guardBypassRef.current = true; try { action(); } finally { guardBypassRef.current = false; } };
  const onTheme = (next: ThemePreference) => applyTheme(next);
  const editorPanel = panel;
  return <div className={`work-app ${editorPanel ? 'has-panel' : ''}`}><Header onOpenMenu={() => setMobileNav(true)} onRefresh={refreshData} onSignOut={signOut} refreshing={refreshing} signingOut={signingOut} theme={theme} onTheme={onTheme} user={actor} /><MobileNavigation aiAvailable={aiAvailable} aiEnabled={personalAIEnabled} debug={autofill.debug} onAIChange={changePersonalAI} onDebugChange={autofill.setDebug} onOpenChange={setMobileNav} onSection={changeSection} onScope={changeScope} open={mobileNav} scope={scope} section={section} /><div className="work-layout"><Sidebar aiAvailable={aiAvailable} aiEnabled={personalAIEnabled} debug={autofill.debug} onAIChange={changePersonalAI} onDebugChange={autofill.setDebug} onSection={changeSection} onScope={changeScope} scope={scope} section={section} /><main className="work-main"><div className="page-heading"><div><h1 id="page-title">{visibleTitle}</h1></div><div className="page-actions">{section === 'work' ? <Button disabled={!canEdit || !snapshot.workstreams.length} onClick={() => openItem()}><Plus /> New work</Button> : section === 'goals' ? <Button disabled={!canEdit} onClick={() => openGoal()} size="sm"><Plus /> New goal</Button> : section === 'streams' ? <Button disabled={!canEdit} onClick={() => openStream()} size="sm"><Plus /> New workstream</Button> : section === 'tags' ? <Button disabled={!canManageTag} onClick={() => openTag()} size="sm"><Plus /> New tag</Button> : null}</div></div>{effectiveAssist && section === 'work' ? <AssessmentControls actorId={actor.id} assessment={assessments} canEdit={canEdit} currentView={filters} viewScope={scope} paused={hasUnsaved || saving || refreshing} pendingCount={pendingAssessmentCount} onRefresh={refreshData} snapshot={snapshot} /> : null}{actionError && !panel ? <Alert variant="destructive" className="error-banner page-error"><CircleAlert aria-hidden="true" /><AlertDescription>{actionError.message}</AlertDescription></Alert> : null}{section === 'work' ? <><FilterBar aiAvailable={effectiveAssist} filters={filters} onFilters={next => setFilters(previous => ({ ...previous, ...next }))} scope={scope} snapshot={snapshot} /><WorkList aiAvailable={effectiveAssist} assessment={assessments} canEdit={canEdit} debug={autofill.debug} filters={filters} matchingIds={matchingIds} onAddSubtask={(item, opener) => openItem(undefined, { parentId: item.id }, opener)} onEdit={(item, opener) => openItem(item, undefined, opener)} onToggleFilter={toggleFilter} onToggleStar={toggleStar} onUpdates={openUpdates} selectedId={selectedId} snapshot={snapshot} userId={actor.id} /></> : section === 'goals' ? <GoalList canEdit={canEdit} onAddStream={(goal, opener) => openStream(undefined, { goalId: goal.id }, opener)} onEdit={(goal, opener) => openGoal(goal, opener)} snapshot={snapshot} /> : section === 'streams' ? <StreamList canEdit={canEdit} onAddTask={(stream, opener) => openItem(undefined, { workstreamId: stream.id }, opener)} onEdit={(stream, opener) => openStream(stream, undefined, opener)} snapshot={snapshot} /> : section === 'tags' ? <TagList canEditTag={canEditTag} onEdit={(tag, opener) => openTag(tag, opener)} snapshot={snapshot} /> : <PeopleList isAdmin={isAdmin} onEdit={(person, opener) => openPerson(person, opener)} snapshot={snapshot} />}</main>{panel === 'updates' ? <UpdatesPanel assessmentOpenRequest={assessmentOpenRequest} debug={autofill.debug && effectiveAssist} assessment={assessments} confirmationOpen={Boolean(pendingAction || pendingPersonCommand || pendingDelete)} updateKind={updateKind} setUpdateKind={setUpdateKind} onResolveBlocker={resolveBlocker} actionError={actionError} canEdit={canEdit} actorId={actor.id} isAdmin={isAdmin} editingUpdateId={editingUpdateId} editingUpdateBody={editingUpdateBody} setEditingUpdateBody={setEditingUpdateBody} onSaveUpdate={saveUpdate} onCancelUpdate={cancelUpdate} onEditUpdate={editUpdate} onDeleteUpdate={requestDeleteUpdate} itemId={editingId} onAddUpdate={addUpdate} onClose={closePanel} openerRef={editorOpenerRef} saving={saving} setUpdateBody={setUpdateBody} snapshot={snapshot} updateBody={updateBody} /> : null}<WorkPanel confirmationOpen={Boolean(pendingAction || pendingPersonCommand || pendingDelete)} canDelete={Boolean(editingId && ((panel === 'item' || panel === 'goal' || panel === 'stream') && canEdit || panel === 'tag' && tagForm && tagWritable))} key={`${panel}:${editingId ?? 'new'}:${editorSession}`} actionError={actionError} assist={{ enabled: effectiveAssist, model: currentAssist.model }} autofill={autofill} canEdit={canEdit} csrfToken={initial.csrfToken} dirty={dirty} editingId={editingId} goalForm={goalForm} isAdmin={isAdmin} itemForm={itemForm} itemKind={itemKind} onClose={closePanel} onDelete={requestDelete} onSave={save} openerRef={editorOpenerRef} panel={editorPanel} personForm={personForm} saving={saving} setGoalForm={setGoalForm} setItemKind={setItemKind} setPersonForm={setPersonForm} setStreamForm={setStreamForm} setTagForm={setTagForm} setDirty={setDirty} snapshot={snapshot} streamForm={streamForm} tagForm={tagForm} userId={actor.id} /></div><AlertDialog open={Boolean(pendingAction)} onOpenChange={open => { if (!open) setPendingAction(null); }}><AlertDialogContent onCloseAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => { const close = document.querySelector<HTMLElement>('.work-panel button[aria-label="Close editor"], .work-panel button[aria-label="Close updates"]'); if (close) close.focus(); else restoreEditorFocus(event, editorOpenerRef.current); }); }}><AlertDialogHeader><AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle><AlertDialogDescription>Your edits have not been saved. Discard them and continue?</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel onClick={() => setPendingAction(null)}>Keep editing</AlertDialogCancel><AlertDialogAction onClick={confirmDiscard}>Discard changes</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><AlertDialog open={Boolean(pendingPersonCommand)} onOpenChange={open => { if (!open) setPendingPersonCommand(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{pendingPersonCommand?.title}</AlertDialogTitle><AlertDialogDescription>{pendingPersonCommand?.description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel onClick={() => setPendingPersonCommand(null)}>Cancel</AlertDialogCancel><AlertDialogAction onClick={() => { void confirmPersonCommand(); }}>Confirm</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog><AlertDialog open={Boolean(pendingDelete)} onOpenChange={open => { if (!open) setPendingDelete(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{pendingDelete?.title}</AlertDialogTitle><AlertDialogDescription>{pendingDelete?.description}{hasUnsaved && pendingDelete?.entity !== 'update' ? ' Any unsaved draft in this editor will be discarded only if you confirm.' : pendingDelete?.entity === 'update' && pendingDelete.command.type === 'update.delete' && editingUpdateId === pendingDelete.command.id && hasUnsaved ? ' Your unsaved edit to this timeline entry will be discarded only if you confirm.' : ''}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={saving} onClick={() => setPendingDelete(null)}>Cancel</AlertDialogCancel><AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={saving} onClick={() => { void confirmDelete(); }}>Delete</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog></div>;
}
