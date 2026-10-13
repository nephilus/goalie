import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Bell, FileText, Plus, X } from 'lucide-react';
import type { Person, Snapshot } from '../shared/work';
import { adrUpdateInputSchema, type Adr, type AdrCommandRequest, type AdrHistoryEntry, type AdrIdentity, type AdrMutationResult, type AdrPage, type AdrUpdateInput, type WorkNotification } from '../shared/adr';
import { adrRequest, AdrRequestError, useAdrResource } from '../lib/use-adrs';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Checkbox } from './ui/checkbox';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogTitle } from './ui/alert-dialog';
import '../adr.css';

const fields = [['context', 'Context'], ['concern', 'Concern'], ['decision', 'Decision'], ['alternatives', 'Alternatives not chosen'], ['consequences', 'Expected consequences'], ['downsides', 'Accepted downsides'], ['rationale', 'Rationale']] as const;
const statuses: Record<Adr['status'], string> = { draft: 'Draft', pending: 'Pending approval', approved: 'Approved', changes_requested: 'Changes requested' };
const personName = (people: Person[], id: string) => people.find(person => person.id === id)?.name ?? 'Unknown person';
const identityName = (people: Person[], identity: AdrIdentity) => identity.kind === 'person' ? personName(people, identity.personId) : `${identity.name} (plain name)`;
const dateTime = (value: string) => new Date(value).toLocaleString();
type ProviderProps = { snapshot: Snapshot; user: Person; csrfToken: string; onChanged: () => void | Promise<void>; onOpenItem: (itemId: string, updateId?: string) => boolean | void | Promise<boolean | void>; onOverlayChange?: (open: boolean) => void; children: ReactNode };
type Overlay = { mode: 'detail'; id: string } | { mode: 'create'; itemId: string } | null;
type Workspace = ProviderProps & { refreshKey: number; openAdr: (id: string) => void; createAdr: (itemId: string) => void; overlayOpen: boolean; openInbox: () => void; refresh: () => void };
const AdrContext = createContext<Workspace | null>(null);
export function useAdrWorkspace() { const value = useContext(AdrContext); if (!value) throw new Error('ADR components require AdrProvider'); return value; }

export function AdrProvider(props: ProviderProps) {
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [inbox, setInbox] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [discard, setDiscard] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [saving, setSaving] = useState(false);
  const pending = useRef<(() => void) | null>(null);
  const trigger = useRef<HTMLElement | null>(null);
  const triggerKey = useRef<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const overlayOpen = !!overlay || inbox;
  const activeOverlay = useRef(overlayOpen);
  activeOverlay.current = overlayOpen;
  const sourceNavigation = useRef(false);
  useEffect(() => { props.onOverlayChange?.(overlayOpen); }, [overlayOpen, props.onOverlayChange]);
  useEffect(() => { if (!dirty) return; const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty]);
  function guard(action: () => void) { if (dirty) { pending.current = action; setDiscard(true); } else action(); }
  function rememberTrigger() { if (!overlayOpen) { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; triggerKey.current = trigger.current?.getAttribute('data-adr-focus') ?? null; sourceNavigation.current = false; } }
  function close() { if (saving) return; guard(() => { setOverlay(null); setInbox(false); setDirty(false); }); }
  function restore(event: Event) { event.preventDefault(); requestAnimationFrame(() => { if (!activeOverlay.current && !sourceNavigation.current) { const target = trigger.current?.isConnected ? trigger.current : triggerKey.current ? document.querySelector<HTMLElement>(`[data-adr-focus="${CSS.escape(triggerKey.current)}"]`) : null; target?.focus(); } sourceNavigation.current = false; }); }
  const value: Workspace = { ...props, onOpenItem: async (itemId, updateId) => { setNavigating(true); try { const result = await props.onOpenItem(itemId, updateId); sourceNavigation.current = result !== false; return result; } finally { setNavigating(false); } }, refreshKey, overlayOpen, refresh: () => setRefreshKey(key => key + 1), openAdr: id => guard(() => { rememberTrigger(); setInbox(false); setOverlay({ mode: 'detail', id }); }), createAdr: itemId => guard(() => { rememberTrigger(); setOverlay({ mode: 'create', itemId }); }), openInbox: () => guard(() => { rememberTrigger(); setOverlay(null); setInbox(true); }) };
  return <AdrContext.Provider value={value}>{props.children}
    <Dialog open={!!overlay} modal={true} onOpenChange={open => { if (!open) close(); }}><DialogContent className="adr-dialog" aria-describedby={undefined} onCloseAutoFocus={restore} onEscapeKeyDown={event => { const picker = (event.target as HTMLElement).closest<HTMLDetailsElement>('.adr-mentions[open]'); if (picker) { event.preventDefault(); picker.open = false; picker.querySelector('summary')?.focus(); } }} onInteractOutside={event => { event.preventDefault(); if (!discard && !navigating) close(); }}>
      {overlay && <AdrOverlay key={overlay.mode === 'detail' ? overlay.id : `new-${overlay.itemId}`} overlay={overlay} onClose={close} onDirty={setDirty} onBusy={setSaving} onCreated={id => setOverlay({ mode: 'detail', id })} />}
    </DialogContent></Dialog>
    <Dialog open={inbox} modal={true} onOpenChange={open => { if (!navigating) setInbox(open); }}><DialogContent className="adr-dialog" aria-describedby={undefined} onCloseAutoFocus={restore}>{inbox && <Inbox onClose={() => setInbox(false)} />}</DialogContent></Dialog>
    <AlertDialog open={discard} onOpenChange={setDiscard}><AlertDialogContent onCloseAutoFocus={event => { if (!activeOverlay.current) restore(event); }}><AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle><AlertDialogDescription>Your ADR changes have not been saved. Keep editing to preserve them.</AlertDialogDescription><AlertDialogFooter><AlertDialogCancel onClick={() => { pending.current = null; }}>Keep editing</AlertDialogCancel><AlertDialogAction onClick={() => { setDirty(false); pending.current?.(); pending.current = null; }}>Discard changes</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </AdrContext.Provider>;
}

function Choice({ label, value, onChange, options, disabled }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[]; disabled?: boolean }) {
  return <Select value={value} onValueChange={onChange} disabled={disabled}><SelectTrigger aria-label={label}><SelectValue placeholder={label} /></SelectTrigger><SelectContent className="adr-select-content">{options.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select>;
}
function Feedback({ loading, error, retry }: { loading: boolean; error: string; retry: () => void }) { return <>{loading && <p className="adr-muted" role="status">Loading…</p>}{error && <div className="adr-error" role="alert"><p>{error}</p><Button variant="outline" onClick={retry}>Try again</Button></div>}</>; }
function Pager({ cursor, nextCursor, setCursor }: { cursor: string; nextCursor: string | null; setCursor: (value: string) => void }) { return cursor || nextCursor ? <nav className="adr-actions" aria-label="Results pages"><Button variant="outline" disabled={!cursor} onClick={() => setCursor('')}>First page</Button><Button variant="outline" disabled={!nextCursor} onClick={() => nextCursor && setCursor(nextCursor)}>Next page</Button></nav> : null; }

export function MentionPicker({ people, value, onChange, disabled = false }: { people: Person[]; value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const [search, setSearch] = useState('');
  const id = useId();
  return <details className="adr-mentions" onKeyDown={event => { if (event.key === 'Escape' && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary>Mention people{value.length ? ` (${value.length})` : ''}</summary><p className="adr-muted">Selected people receive an in-app notification. Typing @name alone does not notify anyone.</p><Input aria-label="Find people to mention" value={search} onChange={event => setSearch(event.target.value)} disabled={disabled} placeholder="Find a person" /><div className="adr-mention-options">{people.filter(person => person.name.toLowerCase().includes(search.toLowerCase())).map(person => <label key={person.id} htmlFor={`${id}-${person.id}`}><Checkbox id={`${id}-${person.id}`} disabled={disabled || (!value.includes(person.id) && value.length >= 100)} checked={value.includes(person.id)} onCheckedChange={checked => onChange(checked === true ? [...value, person.id] : value.filter(item => item !== person.id))} /><span>{person.name}<small>{person.email}</small></span></label>)}</div>{people.length === 0 && <p className="adr-muted">No people available.</p>}</details>;
}

function AdrRows({ itemId }: { itemId?: string }) {
  const work = useAdrWorkspace();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('all');
  const [person, setPerson] = useState('all');
  const [name, setName] = useState('');
  const [role, setRole] = useState('all');
  const [cursor, setCursor] = useState('');
  const query = new URLSearchParams({ limit: '25' });
  if (itemId) query.set('itemId', itemId);
  if (search.trim()) query.set('search', search.trim());
  if (status !== 'all') query.set('status', status);
  if (person !== 'all' && person !== 'name') query.set('personId', person);
  if (person === 'name' && name.trim()) query.set('name', name.trim());
  if (role !== 'all') query.set('role', role);
  if (cursor) query.set('cursor', cursor);
  const resource = useAdrResource<AdrPage<Adr>>(`/api/work/adrs?${query}`, work.refreshKey + work.snapshot.revision);
  function filter(setter: (value: string) => void, value: string) { setter(value); setCursor(''); }
  return <section className="adr-section" aria-label={itemId ? 'Item ADRs' : 'ADR registry'}>
    {itemId && <div className="adr-heading"><h3>ADRs</h3>{work.user.role !== 'viewer' && <Button variant="ghost" data-adr-focus={`create-${itemId}`} onClick={() => work.createAdr(itemId)}><Plus aria-hidden="true" />Add ADR</Button>}</div>}
    {!itemId && <div className="adr-filters"><Input aria-label="Search ADR text or document URL" placeholder="Search decisions or document URLs" maxLength={500} value={search} onChange={event => filter(setSearch, event.target.value)} /><Choice label="Approval status" value={status} onChange={value => filter(setStatus, value)} options={[{ value: 'all', label: 'All statuses' }, ...Object.entries(statuses).map(([value, label]) => ({ value, label }))]} /><Choice label="Requester or approver" value={person} onChange={value => filter(setPerson, value)} options={[{ value: 'all', label: 'Any person' }, { value: 'name', label: 'Plain name…' }, ...work.snapshot.people.map(person => ({ value: person.id, label: `${person.name} (${person.email})` }))]} />{person === 'name' && <Input aria-label="Plain-name filter" placeholder="Plain name" maxLength={100} value={name} onChange={event => filter(setName, event.target.value)} />}<Choice label="Person role" value={role} onChange={value => filter(setRole, value)} options={[{ value: 'all', label: 'Either role' }, { value: 'requester', label: 'Requester' }, { value: 'approver', label: 'Approver' }]} /></div>}
    <Feedback {...resource} retry={resource.reload} />
    {resource.data && <><div className="adr-rows">{resource.data.items.map(adr => <button type="button" className="adr-row" data-adr-focus={itemId ? `item-${itemId}-adr-${adr.id}` : `registry-adr-${adr.id}`} key={adr.id} onClick={() => work.openAdr(adr.id)}><FileText aria-hidden="true" /><span className="adr-row-copy"><strong>{adr.decision}</strong>{!itemId && <span>{work.snapshot.items.find(item => item.id === adr.itemId)?.title ?? 'Owning task'}</span>}<small>Requester: {identityName(work.snapshot.people, adr.requester)} · Approver: {identityName(work.snapshot.people, adr.approver)}</small></span><span className={`adr-status adr-status-${adr.status}`}>{statuses[adr.status]}</span></button>)}</div>{resource.data.items.length === 0 && <p className="adr-muted">{itemId ? 'No decisions recorded for this item.' : 'No ADRs match these filters. Create an ADR from a task’s updates.'}</p>}<Pager cursor={cursor} nextCursor={resource.data.nextCursor} setCursor={setCursor} /></>}
  </section>;
}
export function AdrRegistry() { return <AdrRows />; }
export function ItemAdrs({ itemId }: { itemId: string }) { return <AdrRows key={itemId} itemId={itemId} />; }

function IdentityField({ label, value, onChange, approver = false, disabled }: { label: string; value: AdrIdentity; onChange: (value: AdrIdentity) => void; approver?: boolean; disabled: boolean }) {
  const { snapshot } = useAdrWorkspace();
  return <div className="adr-field"><span>{label}</span><Choice label={label} disabled={disabled} value={value.kind === 'name' ? 'plain-name' : value.personId} onChange={selected => onChange(selected === 'plain-name' ? { kind: 'name', name: '' } : { kind: 'person', personId: selected })} options={[...snapshot.people.filter(person => !approver || person.role !== 'viewer').map(person => ({ value: person.id, label: `${person.name} (${person.email})` })), { value: 'plain-name', label: 'Plain name (not an account)' }]} />{value.kind === 'name' && <Input required aria-label={`${label} plain name`} maxLength={100} value={value.name} disabled={disabled} onChange={event => onChange({ kind: 'name', name: event.target.value })} placeholder="Enter a name" />}{approver && <small className="adr-muted">{value.kind === 'name' ? 'An editor must explicitly record this person’s approval. It is not verified.' : 'Only this nominated account can approve or request changes.'}</small>}</div>;
}
function emptyForm(user: Person): AdrUpdateInput { return { context: '', concern: '', decision: '', alternatives: '', consequences: '', downsides: '', rationale: '', requester: { kind: 'person', personId: user.id }, approver: { kind: 'name', name: '' }, documentUrl: null, mentionedPersonIds: [] }; }
function formFrom(adr: Adr): AdrUpdateInput { const { context, concern, decision, alternatives, consequences, downsides, rationale, requester, approver, documentUrl, mentionedPersonIds } = adr; return { context, concern, decision, alternatives, consequences, downsides, rationale, requester, approver, documentUrl, mentionedPersonIds }; }

function AdrOverlay({ overlay, onClose, onDirty, onBusy, onCreated }: { overlay: NonNullable<Overlay>; onClose: () => void; onDirty: (dirty: boolean) => void; onBusy: (busy: boolean) => void; onCreated: (id: string) => void }) {
  const work = useAdrWorkspace();
  const creating = overlay.mode === 'create';
  const fieldId = useId();
  const resource = useAdrResource<AdrMutationResult>(overlay.mode === 'detail' ? `/api/work/adrs/${encodeURIComponent(overlay.id)}` : null);
  const [saved, setSaved] = useState<Adr | null>(null);
  const [revision, setRevision] = useState(work.snapshot.revision);
  const [form, setForm] = useState<AdrUpdateInput>(() => emptyForm(work.user));
  const [baseline, setBaseline] = useState(() => JSON.stringify(emptyForm(work.user)));
  const [editing, setEditing] = useState(creating);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  const [comment, setComment] = useState('');
  const [respond, setRespond] = useState<'changes' | 'record' | null>(null);
  const [history, setHistory] = useState(false);
  const dirty = (editing && JSON.stringify(form) !== baseline) || !!comment.trim();
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => { if (resource.data) { setSaved(resource.data.adr); setRevision(resource.data.revision); } }, [resource.data]);
  const itemId = overlay.mode === 'create' ? overlay.itemId : saved?.itemId;
  const canEdit = work.user.role !== 'viewer';
  function edit() { if (!saved) return; const value = formFrom(saved); setForm(value); setBaseline(JSON.stringify(value)); setEditing(true); setError(''); }
  async function execute(command: AdrCommandRequest['command']) {
    if (busy || stale) return;
    setBusy(true); setError('');
    try {
      const result = await adrRequest<AdrMutationResult>('/api/work/adrs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': work.csrfToken }, body: JSON.stringify({ expectedRevision: revision, command }) });
      setSaved(result.adr); setRevision(result.revision); setEditing(false); setComment(''); setRespond(null); onDirty(false); work.refresh();
      if (creating) onCreated(result.adr.id);
      try { await work.onChanged(); } catch { setError('ADR saved, but the work list could not refresh. Refresh the work list before making further changes.'); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not save this decision.'); if (reason instanceof AdrRequestError && reason.status === 409) setStale(true); }
    finally { setBusy(false); }
  }
  async function reloadForReview() {
    setBusy(true); setError('');
    try {
      if (overlay.mode === 'detail') { const result = await adrRequest<AdrMutationResult>(`/api/work/adrs/${encodeURIComponent(overlay.id)}`); setSaved(result.adr); setRevision(result.revision); }
      else { const result = await adrRequest<AdrPage<Adr>>(`/api/work/adrs?itemId=${encodeURIComponent(overlay.itemId)}&limit=1`); setRevision(result.revision); }
      setStale(false);
      setError('Latest revision loaded. Review the current decision below and your unsaved changes before saving again.');
      work.refresh();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not reload the latest revision.'); }
    finally { setBusy(false); }
  }
  return <><header className="adr-dialog-header"><div><DialogTitle>{creating ? 'New ADR' : editing ? 'Edit ADR' : 'Architecture decision'}</DialogTitle><p className="adr-muted">{work.snapshot.items.find(item => item.id === itemId)?.title ?? 'Loading owning task…'}</p></div><Button variant="ghost" size="icon" aria-label="Close ADR" disabled={busy} onClick={onClose}><X /></Button></header><div className="adr-dialog-body">
    <Feedback loading={resource.loading} error={resource.error} retry={resource.reload} />
    {error && <div className="adr-error" role="alert"><p>{error}</p>{stale && <><p>Nothing was saved. Your draft is preserved. Load the latest decision and review before retrying.</p><Button variant="outline" disabled={busy} onClick={reloadForReview}>Load latest for review</Button></>}</div>}
    {editing ? <form id="adr-editor" onSubmit={event => { event.preventDefault(); const parsed = adrUpdateInputSchema.safeParse(form); if (!parsed.success) { setError(parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(' · ')); return; } void execute(creating ? { type: 'adr.create', adr: { ...parsed.data, itemId: overlay.itemId } } : { type: 'adr.update', id: (overlay as { id: string }).id, adr: parsed.data }); }}>
      <p className="adr-muted">All seven decision fields are required to save a draft. Saving content or identity changes resets approval to Draft.</p>
      {fields.map(([key, label]) => <div className="adr-field" key={key}><label htmlFor={`${fieldId}-${key}`}>{label}</label><Textarea id={`${fieldId}-${key}`} required maxLength={20000} rows={3} value={form[key]} disabled={busy} onChange={event => setForm({ ...form, [key]: event.target.value })} /></div>)}
      <div className="adr-identities"><IdentityField label="Requester" value={form.requester} disabled={busy} onChange={requester => setForm({ ...form, requester })} /><IdentityField label="Approver" approver value={form.approver} disabled={busy} onChange={approver => setForm({ ...form, approver })} /></div>
      <div className="adr-field"><label htmlFor={`${fieldId}-document`}>Full document URL <small>(optional)</small></label><Input id={`${fieldId}-document`} type="url" maxLength={2048} placeholder="https://" value={form.documentUrl ?? ''} disabled={busy} onChange={event => setForm({ ...form, documentUrl: event.target.value || null })} /></div>
      <MentionPicker people={work.snapshot.people} value={form.mentionedPersonIds ?? []} disabled={busy} onChange={mentionedPersonIds => setForm({ ...form, mentionedPersonIds })} />
      <p className="adr-muted">{creating ? `Created by ${work.user.name}. The creator remains attributed even if the requester differs.` : `Originally created by ${personName(work.snapshot.people, saved?.creatorId ?? '')}. This edit is attributed to ${work.user.name}.`}</p>
      {saved && <details className="adr-current"><summary>Current saved decision for comparison</summary><AdrContent adr={saved} /></details>}
    </form> : saved && <><AdrContent adr={saved} /><div className="adr-actions"><Button variant="outline" disabled={busy || dirty} onClick={async () => { if (await work.onOpenItem(saved.itemId) !== false) onClose(); }}>Open owning task</Button>{canEdit && <Button variant="outline" disabled={busy || dirty} onClick={edit}>Edit ADR</Button>}{canEdit && ['draft', 'changes_requested'].includes(saved.status) && <Button disabled={busy || stale} onClick={() => void execute({ type: 'adr.submit', id: saved.id })}>Request approval</Button>}{canEdit && saved.status === 'pending' && saved.approver.kind === 'person' && saved.approver.personId === work.user.id && <><Button disabled={busy || stale} onClick={() => void execute({ type: 'adr.approve', id: saved.id })}>Approve</Button><Button variant="outline" disabled={busy || stale} onClick={() => setRespond('changes')}>Request changes</Button></>}{canEdit && saved.status === 'pending' && saved.approver.kind === 'name' && <Button disabled={busy || stale} onClick={() => setRespond('record')}>Record approval</Button>}</div>
      {respond && <form className="adr-response" onSubmit={event => { event.preventDefault(); void execute(respond === 'changes' ? { type: 'adr.request_changes', id: saved.id, comment } : { type: 'adr.record_approval', id: saved.id, comment }); }}><p>{respond === 'changes' ? 'Explain what needs to change. Your comment is required and becomes part of history.' : `You are recording approval on behalf of ${identityName(work.snapshot.people, saved.approver)}. This is an assertion by ${work.user.name}, not a verified action by that person.`}</p><div className="adr-field"><label htmlFor={`${fieldId}-comment`}>{respond === 'changes' ? 'Required comment' : 'Approval note (optional)'}</label><Textarea id={`${fieldId}-comment`} required={respond === 'changes'} maxLength={10000} value={comment} disabled={busy} onChange={event => setComment(event.target.value)} /></div><div className="adr-actions"><Button type="submit" disabled={busy || stale || (respond === 'changes' && !comment.trim())}>{respond === 'changes' ? 'Send change request' : 'Confirm recorded approval'}</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { setRespond(null); setComment(''); }}>Cancel</Button></div></form>}
      <Button variant="ghost" aria-expanded={history} onClick={() => setHistory(!history)}>{history ? 'Hide history' : 'View history'}</Button>{history && <AdrHistory adrId={saved.id} />}
    </>}
  </div>{editing && <footer className="adr-dialog-footer"><Button variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button form="adr-editor" type="submit" disabled={busy || stale}>{busy ? 'Saving…' : creating ? 'Save draft' : 'Save changes'}</Button></footer>}</>;
}

function AdrContent({ adr }: { adr: Adr }) {
  const { snapshot } = useAdrWorkspace();
  return <div className="adr-content"><span className={`adr-status adr-status-${adr.status}`}>{statuses[adr.status]}</span><dl className="adr-attribution"><div><dt>Requester</dt><dd>{identityName(snapshot.people, adr.requester)}</dd></div><div><dt>Approver</dt><dd>{identityName(snapshot.people, adr.approver)}</dd></div><div><dt>Created by</dt><dd>{personName(snapshot.people, adr.creatorId)} · {dateTime(adr.createdAt)}</dd></div></dl>{adr.approval && <p className="adr-approval">{adr.approval.mode === 'verified' ? `Verified approval by ${personName(snapshot.people, adr.approval.actorId)}` : `Approval recorded by ${personName(snapshot.people, adr.approval.actorId)} on behalf of ${identityName(snapshot.people, adr.approval.approver)}. Not verified.`} · {dateTime(adr.approval.createdAt)}{adr.approval.comment && <span className="adr-prose">{adr.approval.comment}</span>}</p>}<dl className="adr-content-fields">{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{adr[key]}</dd></div>)}</dl>{adr.documentUrl && /^https?:\/\//i.test(adr.documentUrl) && <a className="adr-document" href={adr.documentUrl} target="_blank" rel="noreferrer">Open full document <span className="sr-only">(opens a new tab)</span></a>}{adr.mentionedPersonIds.length > 0 && <p className="adr-muted">Mentioned: {adr.mentionedPersonIds.map(id => personName(snapshot.people, id)).join(', ')}</p>}</div>;
}
function AdrHistory({ adrId }: { adrId: string }) {
  const { refreshKey, snapshot } = useAdrWorkspace();
  const [cursor, setCursor] = useState('');
  const resource = useAdrResource<AdrPage<AdrHistoryEntry>>(`/api/work/adrs/${encodeURIComponent(adrId)}/history?limit=10${cursor ? `&cursor=${cursor}` : ''}`, refreshKey);
  return <section className="adr-history" aria-label="ADR history"><h3>History</h3><Feedback {...resource} retry={resource.reload} />{resource.data?.items.map(entry => <details key={entry.id}><summary>{entry.action.replace(/^adr\./, '').replaceAll('_', ' ')} · {personName(snapshot.people, entry.actorId)}<small>{dateTime(entry.createdAt)} · Revision {entry.revision}</small></summary>{entry.comment && <p className="adr-prose">{entry.comment}</p>}<AdrContent adr={entry.snapshot} /></details>)}{resource.data && <Pager cursor={cursor} nextCursor={resource.data.nextCursor} setCursor={setCursor} />}</section>;
}

export function NotificationInboxButton() {
  const work = useAdrWorkspace();
  const resource = useAdrResource<AdrPage<WorkNotification>>('/api/work/notifications?unreadOnly=true&limit=100', work.refreshKey + work.snapshot.revision);
  const count = resource.data?.items.length ?? 0;
  return <Button variant="ghost" data-adr-focus="inbox" onClick={work.openInbox} aria-label={`Notifications${count ? `, ${count}${resource.data?.nextCursor ? ' or more' : ''} unread` : ''}`}><Bell aria-hidden="true" /><span>Inbox{count > 0 ? ` (${count}${resource.data?.nextCursor ? '+' : ''})` : ''}</span>{resource.error && <span className="sr-only">Could not check unread notifications</span>}</Button>;
}
function Inbox({ onClose }: { onClose: () => void }) {
  const work = useAdrWorkspace();
  const [unread, setUnread] = useState(false);
  const [cursor, setCursor] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const resource = useAdrResource<AdrPage<WorkNotification>>(`/api/work/notifications?limit=25&unreadOnly=${unread}${cursor ? `&cursor=${cursor}` : ''}`, work.refreshKey);
  async function mark(notification: WorkNotification) { setBusy(notification.id); setError(''); try { await adrRequest<WorkNotification>('/api/work/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-token': work.csrfToken }, body: JSON.stringify({ id: notification.id, read: !notification.readAt }) }); work.refresh(); } catch (reason) { setError(reason instanceof Error ? reason.message : 'Could not update this notification.'); } finally { setBusy(null); } }
  return <><header className="adr-dialog-header"><DialogTitle>Inbox</DialogTitle><Button variant="ghost" size="icon" aria-label="Close inbox" onClick={onClose}><X /></Button></header><div className="adr-dialog-body"><label className="adr-check"><Checkbox checked={unread} onCheckedChange={checked => { setUnread(checked === true); setCursor(''); }} />Unread only</label><Feedback {...resource} retry={resource.reload} />{error && <p className="adr-error" role="alert">{error}</p>}{resource.data?.items.map(notification => <article className="adr-notification" key={notification.id}><div><strong>{notification.kind === 'approval_requested' ? 'Approval requested' : notification.kind === 'approval_result' ? 'Approval response' : 'You were mentioned'}{!notification.readAt && <span className="adr-status">Unread</span>}</strong><p>{work.snapshot.items.find(item => item.id === notification.itemId)?.title ?? 'Owning task'}</p><small className="adr-muted">{personName(work.snapshot.people, notification.actorId)} · {dateTime(notification.createdAt)}</small></div><div className="adr-actions"><Button variant="outline" onClick={async () => { if (notification.adrId) work.openAdr(notification.adrId); else if (await work.onOpenItem(notification.itemId, notification.updateId ?? undefined) !== false) onClose(); }}>Open source</Button><Button variant="ghost" disabled={busy !== null} onClick={() => void mark(notification)}>{busy === notification.id ? 'Updating…' : notification.readAt ? 'Mark unread' : 'Mark read'}</Button></div></article>)}{resource.data?.items.length === 0 && <p className="adr-muted">{unread ? 'No unread notifications.' : 'No notifications yet. Approval requests and mentions will appear here.'}</p>}{resource.data && <Pager cursor={cursor} nextCursor={resource.data.nextCursor} setCursor={setCursor} />}</div></>;
}
