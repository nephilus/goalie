import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Item, Person, Snapshot } from '../shared/work';
import { matchesBaseWorkFilters } from '../shared/work-filters';
import {
  assessmentDetailsSchema,
  assessmentIndexSchema,
  assessmentInputKey,
  buildAssessmentInput,
  assessmentScopeRequestSchema,
  assessmentScopeResponseSchema,
  type AssessmentScope,
  type AssessmentDetails,
  type AssessmentEntry,
  type AssessmentIndex,
  type AssessmentSummary,
} from '../shared/work-assessment';

type AssessmentError = Error & { status?: number; code?: string; retryAfterMs?: number };
export type AssessmentErrorState = { message: string; code?: string; status?: number; retryAfterMs?: number };

type UseWorkAssessmentsOptions = {
  snapshot: Snapshot;
  actor: Person;
  csrfToken: string;
  selectCandidateIds: (asOf: string | null) => string[];
  updatesItemId: string | null;
  workViewActive: boolean;
  pausedForEditing: boolean;
  signingOut: boolean;
  available: boolean;
};

export type UseWorkAssessmentsResult = {
  index: AssessmentIndex | null;
  entriesByItemId: ReadonlyMap<string, AssessmentEntry>;
  summariesByItemId: ReadonlyMap<string, AssessmentSummary>;
  detailsByItemId: ReadonlyMap<string, AssessmentDetails>;
  candidateIds: string[];
  runCandidateIds: string[];
  scope: AssessmentScope | null;
  scopeItemIds: ReadonlySet<string>;
  savingScope: boolean;
  scopeError: string | null;
  setScope: (scope: AssessmentScope) => Promise<boolean>;
  serverAsOf: string | null;
  enabled: boolean;
  provider: AssessmentIndex['provider'];
  loading: boolean;
  pendingIds: ReadonlySet<string>;
  errorsByItemId: ReadonlyMap<string, AssessmentErrorState>;
  pausedError: string | null;
  locallyStopped: boolean;
  refreshRequiredIds: ReadonlySet<string>;
  setEnabled: (enabled: boolean) => Promise<boolean>;
  retryItem: (itemId: string) => void;
  resume: () => void;
  refresh: () => Promise<AssessmentIndex | null>;
  loadDetails: (itemId: string) => Promise<AssessmentDetails | null>;
};

const DEBOUNCE_MS = 1_000;
const CLOCK_CHECK_MS = 60_000;
const BUSY_RETRY_MS = 2_000;

type ClockAnchor = { serverNow: string; receivedAt: number; asOf: string };

function responseMessage(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string') return body.error;
  return fallback;
}

async function parseResponse<T>(response: Response, parse: (value: unknown) => T): Promise<T> {
  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(responseMessage(body, `Request failed (${response.status})`)) as AssessmentError;
    error.status = response.status;
    if (body && typeof body === 'object' && 'code' in body && typeof body.code === 'string') error.code = body.code;
    const retryAfter = response.headers.get('retry-after');
    if (retryAfter) error.retryAfterMs = Math.max(0, Number(retryAfter) * 1_000 || 0);
    throw error;
  }
  const payload = body && typeof body === 'object' && 'data' in body ? body.data : body;
  return parse(payload);
}

function identity(itemId: string, inputKey: string): string { return `${itemId}\u0000${inputKey}`; }
function itemIdentityPrefix(itemId: string): string { return `${itemId}\u0000`; }
function inferredDate(anchor: ClockAnchor | null): string | null {
  if (!anchor) return null;
  const elapsed = typeof performance === 'undefined' ? 0 : Math.max(0, performance.now() - anchor.receivedAt);
  return new Date(Date.parse(anchor.serverNow) + elapsed).toISOString().slice(0, 10);
}

function detailsMatchEntry(details: AssessmentDetails, entry: AssessmentEntry): boolean {
  if (details.entry.itemId !== entry.itemId || details.entry.state !== entry.state || details.entry.currentInputKey !== entry.currentInputKey) return false;
  if (!entry.assessment) return details.record === null;
  return details.record?.inputKey === entry.assessment.inputKey && details.record.assessedAt === entry.assessment.assessedAt;
}

function assessmentSourceSignature(snapshot: Snapshot, itemId: string): string {
  // Clock rollover is handled separately; use the canonical bounded source shape.
  return JSON.stringify(buildAssessmentInput(snapshot, itemId, '1970-01-01'));
}

function matchesSavedScope(item: Item, snapshot: Snapshot, actorId: string, index: AssessmentIndex | null): boolean {
  if (!index?.scope || item.status === 'done' || !index.scopeItemIds.includes(item.id)) return false;
  return matchesBaseWorkFilters(item, snapshot, index.scope, index.scope.scope, actorId, index.asOf);
}

export function useWorkAssessments({ snapshot, actor, csrfToken, selectCandidateIds, updatesItemId, workViewActive, pausedForEditing, signingOut, available }: UseWorkAssessmentsOptions): UseWorkAssessmentsResult {
  const sessionKey = `${actor.id}\u0000${csrfToken}`;
  const [index, setIndex] = useState<AssessmentIndex | null>(null);
  const [loading, setLoading] = useState(false);
  const [metadataFresh, setMetadataFresh] = useState(false);
  const [localToday, setLocalToday] = useState(() => new Date().toISOString().slice(0, 10));
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set());
  const [errorsByItemId, setErrorsByItemId] = useState<Map<string, AssessmentErrorState>>(() => new Map());
  const [pausedError, setPausedError] = useState<string | null>(null);
  const [refreshRequiredIds, setRefreshRequiredIds] = useState<Set<string>>(() => new Set());
  const [detailsByItemId, setDetailsByItemId] = useState<Map<string, AssessmentDetails>>(() => new Map());
  const [anchor, setAnchor] = useState<ClockAnchor | null>(null);
  const [locallyStoppedState, setLocallyStoppedState] = useState(false);
  const [visible, setVisible] = useState(true);
  const [savingScope, setSavingScope] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);

  const visibleRef = useRef(true);
  const indexRef = useRef<AssessmentIndex | null>(null);
  const snapshotRef = useRef(snapshot);
  const csrfRef = useRef(csrfToken);
  const sessionRef = useRef(sessionKey);
  const currentSessionRef = useRef(sessionKey);
  const canAssessRef = useRef(actor.role !== 'viewer');
  const actorIdRef = useRef(actor.id);
  const scopeBlockedRef = useRef(false);
  const scopeSaveAbortRef = useRef<AbortController | null>(null);
  const preferenceAbortRef = useRef<AbortController | null>(null);
  const preferenceGenerationRef = useRef(0);
  const workActiveRef = useRef(workViewActive);
  const pausedEditingRef = useRef(pausedForEditing);
  const signingOutRef = useRef(signingOut);
  const availableRef = useRef(available);
  const metadataFreshRef = useRef(false);
  const pausedErrorRef = useRef<string | null>(null);
  const localStopRef = useRef(false);
  const generationRef = useRef(0);
  const metadataAbortRef = useRef<AbortController | null>(null);
  const assessmentAbortRef = useRef<AbortController | null>(null);
  const detailAbortRefs = useRef(new Map<string, AbortController>());
  const detailsRef = useRef(detailsByItemId);
  const queueRef = useRef<string[]>([]);
  const queuedRef = useRef(new Set<string>());
  const runningRef = useRef(false);
  const busyTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const failedKeysRef = useRef(new Set<string>());
  const anchorRef = useRef<ClockAnchor | null>(null);
  const pendingRef = useRef(pendingIds);
  const schedulingIdsRef = useRef<string[]>([]);
  const pumpRef = useRef<() => void>(() => undefined);
  const lastSnapshotRevisionRef = useRef(snapshot.revision);
  const lastStarsRef = useRef(snapshot.starredItemIds.join('\u0000'));
  const lastSourceSignaturesRef = useRef(new Map(snapshot.items.map(item => [item.id, assessmentSourceSignature(snapshot, item.id)])));
  const isInScope = useCallback((itemId: string) => {
    const item = snapshotRef.current.items.find(value => value.id === itemId);
    return Boolean(item && matchesSavedScope(item, snapshotRef.current, actorIdRef.current, indexRef.current));
  }, []);
  const setPause = useCallback((value: string | null) => {
    pausedErrorRef.current = value;
    setPausedError(value);
  }, []);

  // Publish committed state before async continuations, never speculative renders.
  useLayoutEffect(() => {
    indexRef.current = index;
    snapshotRef.current = snapshot;
    csrfRef.current = csrfToken;
    currentSessionRef.current = sessionKey;
    canAssessRef.current = actor.role !== 'viewer';
    actorIdRef.current = actor.id;
    workActiveRef.current = workViewActive;
    pausedEditingRef.current = pausedForEditing;
    signingOutRef.current = signingOut;
    availableRef.current = available;
    pausedErrorRef.current = pausedError;
    pendingRef.current = pendingIds;
    detailsRef.current = detailsByItemId;
    anchorRef.current = anchor;
  });

  const stopScheduling = useCallback((abortAssessment = true) => {
    generationRef.current += 1;
    queueRef.current = [];
    queuedRef.current.clear();
    runningRef.current = false;
    clearTimeout(busyTimerRef.current);
    busyTimerRef.current = undefined;
    if (abortAssessment) assessmentAbortRef.current?.abort();
    assessmentAbortRef.current = null;
    setPendingIds(new Set());
    setLoading(false);
  }, []);
  useEffect(() => {
    if (available) return;
    stopScheduling();
    metadataAbortRef.current?.abort();
    metadataAbortRef.current = null;
    detailAbortRefs.current.forEach(controller => controller.abort());
    detailAbortRefs.current.clear();
    scopeSaveAbortRef.current?.abort();
    scopeSaveAbortRef.current = null;
    preferenceGenerationRef.current += 1;
    preferenceAbortRef.current?.abort();
    preferenceAbortRef.current = null;
    scopeBlockedRef.current = false;
    metadataFreshRef.current = false;
    setMetadataFresh(false);
    setIndex(null);
    setAnchor(null);
    setDetailsByItemId(new Map());
    setErrorsByItemId(new Map());
    setRefreshRequiredIds(new Set());
    setSavingScope(false);
    setScopeError(null);
    setPause(null);
  }, [available, setPause, stopScheduling]);

  const readIndex = useCallback(async (signal?: AbortSignal): Promise<AssessmentIndex | null> => {
    const readSession = currentSessionRef.current;
    if (!availableRef.current || !workActiveRef.current || signingOutRef.current || readSession !== sessionKey) return null;
    metadataFreshRef.current = false;
    setMetadataFresh(false);
    setLoading(true);
    try {
      const response = await fetch('/api/work/assessments', { credentials: 'same-origin', signal });
      const value = await parseResponse(response, body => assessmentIndexSchema.parse(body));
      if (signal?.aborted || !availableRef.current || readSession !== currentSessionRef.current || readSession !== sessionKey || signingOutRef.current || !visibleRef.current || (typeof document !== 'undefined' && document.visibilityState !== 'visible')) return null;
      const previousIndex = indexRef.current;
      if (previousIndex && (JSON.stringify(previousIndex.scope) !== JSON.stringify(value.scope) || JSON.stringify(previousIndex.scopeItemIds) !== JSON.stringify(value.scopeItemIds))) stopScheduling();
      const entriesById = new Map(value.entries.map(entry => [entry.itemId, entry]));
      const detailItemIds = new Set([...detailsRef.current.keys(), ...detailAbortRefs.current.keys()]);
      detailItemIds.forEach(itemId => {
        const entry = entriesById.get(itemId);
        const details = detailsRef.current.get(itemId);
        const previousEntry = indexRef.current?.entries.find(value => value.itemId === itemId);
        const unchanged = entry && previousEntry && entry.state === previousEntry.state && entry.currentInputKey === previousEntry.currentInputKey && entry.assessment?.inputKey === previousEntry.assessment?.inputKey && entry.assessment?.assessedAt === previousEntry.assessment?.assessedAt;
        if (entry && (details ? detailsMatchEntry(details, entry) : unchanged)) return;
        detailAbortRefs.current.get(itemId)?.abort();
        detailAbortRefs.current.delete(itemId);
      });
      setDetailsByItemId(previous => {
        let changed = false;
        const next = new Map(previous);
        previous.forEach((details, itemId) => {
          const entry = entriesById.get(itemId);
          if (entry && detailsMatchEntry(details, entry)) return;
          next.delete(itemId);
          changed = true;
        });
        return changed ? next : previous;
      });
      indexRef.current = value;
      metadataFreshRef.current = true;
      setMetadataFresh(true);
      setIndex(value);
      setAnchor({ serverNow: value.serverNow, receivedAt: typeof performance === 'undefined' ? 0 : performance.now(), asOf: value.asOf });
      if (value.entries.some(entry => entry.state === 'current')) {
        setErrorsByItemId(previous => {
          const next = new Map(previous);
          value.entries.forEach(entry => { if (entry.state === 'current') next.delete(entry.itemId); });
          return next;
        });
      }
      return value;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      if (!signal?.aborted && availableRef.current && readSession === currentSessionRef.current && readSession === sessionKey && !signingOutRef.current) setPause(error instanceof Error ? error.message : 'Assessments could not be loaded.');
      return null;
    } finally {
      if (metadataAbortRef.current?.signal === signal && availableRef.current && readSession === currentSessionRef.current) setLoading(false);
    }
  }, [sessionKey, setPause, stopScheduling]);

  const refresh = useCallback(async (): Promise<AssessmentIndex | null> => {
    if (!availableRef.current || !workActiveRef.current || signingOutRef.current) return null;
    metadataAbortRef.current?.abort();
    const controller = new AbortController();
    metadataAbortRef.current = controller;
    try { return await readIndex(controller.signal); } finally { if (metadataAbortRef.current === controller) metadataAbortRef.current = null; }
  }, [readIndex]);

  const invalidateSession = useCallback(() => {
    stopScheduling();
    metadataAbortRef.current?.abort();
    metadataAbortRef.current = null;
    detailAbortRefs.current.forEach(controller => controller.abort());
    detailAbortRefs.current.clear();
    scopeSaveAbortRef.current?.abort();
    scopeSaveAbortRef.current = null;
    preferenceGenerationRef.current += 1;
    preferenceAbortRef.current?.abort();
    preferenceAbortRef.current = null;
    scopeBlockedRef.current = false;
    setSavingScope(false);
    setScopeError(null);
    metadataFreshRef.current = false;
    setMetadataFresh(false);
    setIndex(null);
    setAnchor(null);
    setErrorsByItemId(new Map());
    setRefreshRequiredIds(new Set());
    setDetailsByItemId(new Map());
    setPause(null);
    setLocallyStoppedState(false);
    localStopRef.current = false;
    failedKeysRef.current.clear();
  }, [setPause, stopScheduling]);

  useEffect(() => () => {
    generationRef.current += 1;
    queueRef.current = [];
    queuedRef.current.clear();
    clearTimeout(busyTimerRef.current);
    metadataAbortRef.current?.abort();
    assessmentAbortRef.current?.abort();
    preferenceGenerationRef.current += 1;
    preferenceAbortRef.current?.abort();
    scopeSaveAbortRef.current?.abort();
    detailAbortRefs.current.forEach(controller => controller.abort());
    detailAbortRefs.current.clear();
  }, []);

  useLayoutEffect(() => {
    if (sessionRef.current === sessionKey && !signingOut) return;
    sessionRef.current = sessionKey;
    invalidateSession();
  }, [invalidateSession, sessionKey, signingOut]);

  useEffect(() => {
    if (signingOut) {
      stopScheduling();
      metadataAbortRef.current?.abort();
      preferenceGenerationRef.current += 1;
      preferenceAbortRef.current?.abort();
      preferenceAbortRef.current = null;
    }
  }, [signingOut, stopScheduling]);

  useEffect(() => {
    if (!available || !workViewActive || signingOut) return;
    void refresh();
    return () => metadataAbortRef.current?.abort();
  }, [available, refresh, sessionKey, signingOut, workViewActive]);

  useLayoutEffect(() => {
    const stars = snapshot.starredItemIds.join('\u0000');
    const changed = lastSnapshotRevisionRef.current !== snapshot.revision;
    const scopeStarsChanged = Boolean(indexRef.current?.scope?.starredOnly && lastStarsRef.current !== stars);
    const nextSourceSignatures = new Map(snapshot.items.map(item => [item.id, assessmentSourceSignature(snapshot, item.id)]));
    const changedItemIds = new Set<string>();
    for (const [itemId, previousSignature] of lastSourceSignaturesRef.current) {
      if (nextSourceSignatures.get(itemId) !== previousSignature) changedItemIds.add(itemId);
    }
    lastSnapshotRevisionRef.current = snapshot.revision;
    lastStarsRef.current = stars;
    lastSourceSignaturesRef.current = nextSourceSignatures;
    if (scopeStarsChanged || changed) {
      if (changedItemIds.size && indexRef.current) {
        const nextIndex: AssessmentIndex = {
          ...indexRef.current,
          entries: indexRef.current.entries.map(entry => changedItemIds.has(entry.itemId)
            ? { ...entry, state: 'stale', currentInputKey: null }
            : entry),
        };
        indexRef.current = nextIndex;
        setIndex(nextIndex);
        setDetailsByItemId(previous => new Map([...previous].filter(([itemId]) => !changedItemIds.has(itemId))));
      }
      // Every saved revision can change scope membership, even without changing
      // model input. Current input keys prevent another provider call.
      metadataFreshRef.current = false;
      setMetadataFresh(false);
      stopScheduling();
      void refresh();
    }
  }, [refresh, snapshot.items, snapshot.revision, snapshot.starredItemIds.join('\u0000'), stopScheduling]);

  useEffect(() => {
    const onVisibility = () => {
      const nextVisible = document.visibilityState === 'visible';
      visibleRef.current = nextVisible;
      setVisible(nextVisible);
      metadataFreshRef.current = false;
      setMetadataFresh(false);
      if (!nextVisible) {
        metadataAbortRef.current?.abort();
        stopScheduling();
      } else if (workActiveRef.current && !signingOutRef.current) {
        void refresh();
      }
    };
    const initiallyVisible = document.visibilityState === 'visible';
    visibleRef.current = initiallyVisible;
    setVisible(initiallyVisible);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [refresh, stopScheduling]);

  useEffect(() => {
    if (!workViewActive || signingOut) return;
    const timer = setInterval(() => {
      const today = new Date().toISOString().slice(0, 10);
      setLocalToday(previous => previous === today ? previous : today);
      if (!availableRef.current || document.visibilityState !== 'visible') return;
      const date = inferredDate(anchorRef.current);
      if (date && anchorRef.current && date !== anchorRef.current.asOf) void refresh();
    }, CLOCK_CHECK_MS);
    return () => clearInterval(timer);
  }, [refresh, signingOut, workViewActive]);

  const currentIds = useMemo(() => [...new Set(selectCandidateIds(index?.asOf ?? localToday))], [index?.asOf, localToday, selectCandidateIds]);
  const scopeItemIds = useMemo(() => new Set(snapshot.items.filter(item => matchesSavedScope(item, snapshot, actor.id, index)).map(item => item.id)), [actor.id, index?.scope, index?.scopeItemIds, index?.asOf, snapshot]);
  const schedulingIds = useMemo(() => {
    if (!available) return [];
    const ids = currentIds.filter(itemId => scopeItemIds.has(itemId));
    if (updatesItemId && scopeItemIds.has(updatesItemId) && !ids.includes(updatesItemId)) ids.push(updatesItemId);
    return ids;
  }, [available, currentIds, scopeItemIds, updatesItemId]);
  useLayoutEffect(() => { schedulingIdsRef.current = schedulingIds; }, [schedulingIds]);

  const entriesByItemId = useMemo(() => new Map((index?.entries ?? []).map(entry => [entry.itemId, entry])), [index]);
  const summariesByItemId = useMemo(() => new Map((index?.entries ?? []).flatMap(entry => entry.assessment ? [[entry.itemId, entry.assessment] as const] : [])), [index]);
  const entriesSignature = useMemo(() => (index?.entries ?? []).map(entry => `${entry.itemId}:${entry.state}:${entry.currentInputKey ?? ''}`).join('\u0000'), [index]);

  const enqueue = useCallback((itemIds: string[]) => {
    if (!availableRef.current || scopeBlockedRef.current || !metadataFreshRef.current || !canAssessRef.current || sessionRef.current !== currentSessionRef.current || localStopRef.current || pausedErrorRef.current || pausedEditingRef.current || signingOutRef.current || !workActiveRef.current || document.visibilityState !== 'visible') return;
    itemIds.forEach(itemId => {
      if (!schedulingIdsRef.current.includes(itemId) || !isInScope(itemId) || queuedRef.current.has(itemId) || pendingRef.current.has(itemId)) return;
      queuedRef.current.add(itemId);
      queueRef.current.push(itemId);
    });
    pumpRef.current();
  }, [isInScope]);

  const runItem = useCallback(async (itemId: string, expectedKey: string): Promise<void> => {
    const runSession = currentSessionRef.current;
    if (!availableRef.current || runSession !== sessionKey || signingOutRef.current || scopeBlockedRef.current || !isInScope(itemId)) return;
    const generation = generationRef.current;
    const controller = new AbortController();
    assessmentAbortRef.current = controller;
    setPendingIds(previous => new Set(previous).add(itemId));
    try {
      const response = await fetch('/api/work/assessments', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfRef.current }, body: JSON.stringify({ itemId, inputKey: expectedKey }) });
      const details = await parseResponse(response, body => assessmentDetailsSchema.parse(body));
      if (!availableRef.current || runSession !== currentSessionRef.current || runSession !== sessionKey || generation !== generationRef.current || signingOutRef.current || localStopRef.current || scopeBlockedRef.current || !isInScope(itemId)) return;
      const serviceIndex = indexRef.current;
      const currentItem = snapshotRef.current.items.find(value => value.id === itemId);
      const currentInput = serviceIndex?.provider.model && currentItem ? buildAssessmentInput(snapshotRef.current, itemId, serviceIndex.asOf) : null;
      const currentKey = currentInput && serviceIndex?.provider.model ? await assessmentInputKey(currentInput, serviceIndex.provider.model) : null;
      if (!availableRef.current || runSession !== currentSessionRef.current || runSession !== sessionKey || !metadataFreshRef.current || !currentKey || currentKey !== expectedKey || details.record?.inputKey !== expectedKey || generation !== generationRef.current || !schedulingIdsRef.current.includes(itemId) || pausedEditingRef.current || document.visibilityState !== 'visible') {
        if (!availableRef.current || runSession !== currentSessionRef.current || runSession !== sessionKey) return;
        setRefreshRequiredIds(previous => new Set(previous).add(itemId));
        setDetailsByItemId(previous => { const next = new Map(previous); next.delete(itemId); return next; });
        return;
      }
      setDetailsByItemId(previous => new Map(previous).set(itemId, details));
      setErrorsByItemId(previous => { const next = new Map(previous); next.delete(itemId); return next; });
      setRefreshRequiredIds(previous => { const next = new Set(previous); next.delete(itemId); return next; });
      if (serviceIndex) {
        const nextIndex = { ...serviceIndex, entries: serviceIndex.entries.map(entry => entry.itemId === itemId ? details.entry : entry) };
        indexRef.current = nextIndex;
        setIndex(nextIndex);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (!availableRef.current || runSession !== currentSessionRef.current || runSession !== sessionKey || signingOutRef.current) return;
      const typed = error as AssessmentError;
      if (generation !== generationRef.current) return;
      const state = { message: typed.message || 'Assessment failed.', code: typed.code, status: typed.status, retryAfterMs: typed.retryAfterMs };
      if (typed.code === 'assessment_busy') {
        if (!queuedRef.current.has(itemId)) { queuedRef.current.add(itemId); queueRef.current.unshift(itemId); }
        clearTimeout(busyTimerRef.current);
        busyTimerRef.current = setTimeout(() => { busyTimerRef.current = undefined; pumpRef.current(); }, typed.retryAfterMs || BUSY_RETRY_MS);
      } else if (typed.code === 'assessment_out_of_scope' || typed.code === 'assessment_scope_required') {
        await refresh();
      } else {
        failedKeysRef.current.add(identity(itemId, expectedKey));
        if (typed.code === 'assessment_source_changed' || typed.code === 'assessment_model_changed') {
          setRefreshRequiredIds(previous => new Set(previous).add(itemId));
          setDetailsByItemId(previous => { const next = new Map(previous); next.delete(itemId); return next; });
          await refresh();
        } else {
          setErrorsByItemId(previous => new Map(previous).set(itemId, state));
          if (typed.status !== 422) setPause(state.message);
        }
      }
    } finally {
      if (runSession === currentSessionRef.current && runSession === sessionKey && generation === generationRef.current) setPendingIds(previous => { const next = new Set(previous); next.delete(itemId); return next; });
      if (runSession === currentSessionRef.current && assessmentAbortRef.current === controller) assessmentAbortRef.current = null;
    }
  }, [isInScope, refresh, sessionKey, setPause]);

  const pump = useCallback(() => {
    const pumpSession = currentSessionRef.current;
    if (!availableRef.current || scopeBlockedRef.current || !metadataFreshRef.current || !canAssessRef.current || pumpSession !== sessionKey || sessionRef.current !== pumpSession || localStopRef.current || pausedErrorRef.current || pausedEditingRef.current || signingOutRef.current || !workActiveRef.current || document.visibilityState !== 'visible' || runningRef.current || busyTimerRef.current) return;
    const itemId = queueRef.current.shift();
    if (!itemId) return;
    queuedRef.current.delete(itemId);
    const serviceIndex = indexRef.current;
    const item = snapshotRef.current.items.find(value => value.id === itemId);
    if (!serviceIndex?.enabled || !serviceIndex.provider.enabled || !serviceIndex.provider.model || !item || !isInScope(itemId) || !schedulingIdsRef.current.includes(itemId)) { pumpRef.current(); return; }
    const generation = generationRef.current;
    const input = buildAssessmentInput(snapshotRef.current, itemId, serviceIndex.asOf);
    if (!input) { pumpRef.current(); return; }
    runningRef.current = true;
    void assessmentInputKey(input, serviceIndex.provider.model).then(async expectedKey => {
      if (!availableRef.current || scopeBlockedRef.current || !isInScope(itemId) || !metadataFreshRef.current || !canAssessRef.current || pumpSession !== currentSessionRef.current || pumpSession !== sessionKey || sessionRef.current !== pumpSession || generation !== generationRef.current || localStopRef.current || pausedErrorRef.current || pausedEditingRef.current || signingOutRef.current || !workActiveRef.current || document.visibilityState !== 'visible' || !schedulingIdsRef.current.includes(itemId)) return;
      const entry = indexRef.current?.entries.find(value => value.itemId === itemId);
      if (entry?.currentInputKey && entry.currentInputKey !== expectedKey) {
        setRefreshRequiredIds(previous => new Set(previous).add(itemId));
        setDetailsByItemId(previous => { const next = new Map(previous); next.delete(itemId); return next; });
        return;
      }
      if (entry?.state === 'current' && entry.currentInputKey === expectedKey) return;
      if (failedKeysRef.current.has(identity(itemId, expectedKey))) return;
      await runItem(itemId, expectedKey);
    }).catch(error => {
      if (pumpSession === currentSessionRef.current && pumpSession === sessionKey && generation === generationRef.current) setPause(error instanceof Error ? error.message : 'Assessment input could not be prepared.');
    }).finally(() => {
      if (pumpSession !== currentSessionRef.current || pumpSession !== sessionKey || generation !== generationRef.current) return;
      runningRef.current = false;
      pumpRef.current();
    });
  }, [isInScope, runItem, sessionKey, setPause]);
  useLayoutEffect(() => { pumpRef.current = pump; }, [pump]);

  useEffect(() => {
    if (!availableRef.current || !index?.provider.enabled || !index.provider.model || signingOut) return;
    let disposed = false;
    void Promise.all(currentIds.map(async itemId => {
      const input = buildAssessmentInput(snapshot, itemId, index.asOf);
      if (!input) return;
      const key = await assessmentInputKey(input, index.provider.model!);
      if (disposed || !availableRef.current || currentSessionRef.current !== sessionKey || signingOutRef.current) return;
      const entry = indexRef.current?.entries.find(value => value.itemId === itemId);
      if (entry?.currentInputKey && entry.currentInputKey !== key) {
        setRefreshRequiredIds(previous => new Set(previous).add(itemId));
        setDetailsByItemId(previous => { const next = new Map(previous); next.delete(itemId); return next; });
      } else if (entry?.currentInputKey === key) {
        setRefreshRequiredIds(previous => { const next = new Set(previous); next.delete(itemId); return next; });
      }
    }));
    return () => { disposed = true; };
  }, [currentIds.join('\u0000'), entriesSignature, index?.asOf, index?.provider.enabled, index?.provider.model, snapshot.revision, signingOut, sessionKey]);
  useEffect(() => {
    if (!availableRef.current || savingScope || scopeError || !metadataFresh || !visible || actor.role === 'viewer' || !index?.enabled || !index.scope || !index.provider.enabled || !index.provider.model || pausedError || pausedForEditing || signingOut || !workViewActive || localStopRef.current || document.visibilityState !== 'visible') return;
    let disposed = false;
    const generation = generationRef.current;
    const timer = setTimeout(() => {
      if (disposed || !availableRef.current || generation !== generationRef.current || scopeBlockedRef.current || !metadataFreshRef.current || !visibleRef.current) return;
      const serviceIndex = indexRef.current;
      const ids = schedulingIdsRef.current;
      if (!serviceIndex?.provider.model) return;
      void Promise.all(ids.map(async itemId => {
        const input = buildAssessmentInput(snapshotRef.current, itemId, serviceIndex.asOf);
        if (!input) return;
        const key = await assessmentInputKey(input, serviceIndex.provider.model!);
        if (disposed || !availableRef.current || generation !== generationRef.current || !metadataFreshRef.current || !visibleRef.current) return;
        const entry = serviceIndex.entries.find(value => value.itemId === itemId);
        if (entry?.currentInputKey && entry.currentInputKey !== key) {
          setRefreshRequiredIds(previous => new Set(previous).add(itemId));
          setDetailsByItemId(previous => { const next = new Map(previous); next.delete(itemId); return next; });
          return;
        }
        if (!entry || entry.state === 'stale' || entry.state === 'missing') enqueue([itemId]);
      }));
    }, DEBOUNCE_MS);
    return () => { disposed = true; clearTimeout(timer); };
  }, [available, locallyStoppedState, savingScope, scopeError, metadataFresh, visible, actor.role, entriesSignature, index?.asOf, index?.enabled, index?.scope, index?.provider.enabled, index?.provider.model, pausedError, pausedForEditing, schedulingIds.join('\u0000'), signingOut, snapshot.revision, workViewActive, enqueue]);

  useEffect(() => {
    if (actor.role !== 'viewer' && !pausedForEditing && workViewActive && !signingOut) return;
    stopScheduling();
  }, [actor.role, pausedForEditing, signingOut, stopScheduling, workViewActive]);

  const setEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    if (!availableRef.current || signingOutRef.current || (enabled && (scopeBlockedRef.current || !indexRef.current?.scope))) return false;
    const session = currentSessionRef.current;
    localStopRef.current = true;
    setLocallyStoppedState(true);
    stopScheduling();
    preferenceGenerationRef.current += 1;
    preferenceAbortRef.current?.abort();
    const controller = new AbortController();
    preferenceAbortRef.current = controller;
    const operationGeneration = preferenceGenerationRef.current;
    try {
      const response = await fetch('/api/work/assessments/preference', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfRef.current }, body: JSON.stringify({ enabled }) });
      const preference = await parseResponse(response, body => {
        if (!body || typeof body !== 'object' || !('enabled' in body) || typeof body.enabled !== 'boolean') throw new Error('The assessment preference response was invalid.');
        return body.enabled;
      });
      if (controller.signal.aborted || !availableRef.current || preferenceGenerationRef.current !== operationGeneration || currentSessionRef.current !== session || signingOutRef.current) return false;
      if (preference !== enabled) throw new Error('The assessment preference was not confirmed.');
      const fresh = await refresh();
      if (controller.signal.aborted || !availableRef.current || preferenceGenerationRef.current !== operationGeneration || currentSessionRef.current !== session || signingOutRef.current) return false;
      if (!fresh || fresh.enabled !== enabled) throw new Error('The assessment preference could not be confirmed from the server.');
      setPause(null);
      localStopRef.current = false;
      setLocallyStoppedState(false);
      return true;
    } catch (error) {
      if (controller.signal.aborted || !availableRef.current || preferenceGenerationRef.current !== operationGeneration || currentSessionRef.current !== session || signingOutRef.current) return false;
      setPause(error instanceof Error ? error.message : `Assessments could not be turned ${enabled ? 'on' : 'off'}.`);
      localStopRef.current = true;
      setLocallyStoppedState(true);
      return false;
    } finally {
      if (preferenceAbortRef.current === controller) preferenceAbortRef.current = null;
    }
  }, [refresh, setPause, stopScheduling]);

  const setScope = useCallback(async (scope: AssessmentScope): Promise<boolean> => {
    const session = currentSessionRef.current;
    if (!availableRef.current || session !== sessionKey || signingOutRef.current || !canAssessRef.current || scopeSaveAbortRef.current) return false;
    const controller = new AbortController();
    scopeSaveAbortRef.current = controller;
    scopeBlockedRef.current = true;
    setSavingScope(true);
    setScopeError(null);
    stopScheduling();
    metadataAbortRef.current?.abort();
    metadataFreshRef.current = false;
    setMetadataFresh(false);
    try {
      const payload = assessmentScopeRequestSchema.parse({ scope });
      const response = await fetch('/api/work/assessments/scope', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfRef.current }, body: JSON.stringify(payload) });
      const saved = await parseResponse(response, body => assessmentScopeResponseSchema.parse(body));
      if (controller.signal.aborted || !availableRef.current || currentSessionRef.current !== session || signingOutRef.current) return false;
      if (JSON.stringify(saved.scope) !== JSON.stringify(payload.scope)) throw new Error('The saved Goalie scope was not confirmed.');
      const fresh = await refresh();
      if (controller.signal.aborted || !availableRef.current || currentSessionRef.current !== session || signingOutRef.current) return false;
      if (!fresh || JSON.stringify(fresh.scope) !== JSON.stringify(saved.scope)) throw new Error('The Goalie scope could not be confirmed. Open Scope and save again before resuming.');
      scopeBlockedRef.current = false;
      return true;
    } catch (error) {
      if (controller.signal.aborted || !availableRef.current || currentSessionRef.current !== session || signingOutRef.current) return false;
      setScopeError(error instanceof Error ? error.message : 'The Goalie scope could not be saved. Open Scope and try again.');
      return false;
    } finally {
      if (currentSessionRef.current === session && scopeSaveAbortRef.current === controller) {
        scopeSaveAbortRef.current = null;
        setSavingScope(false);
      }
    }
  }, [refresh, sessionKey, stopScheduling]);

  const retryItem = useCallback((itemId: string) => {
    if (!availableRef.current || scopeBlockedRef.current || !isInScope(itemId) || !schedulingIdsRef.current.includes(itemId) || !metadataFreshRef.current || !visibleRef.current || currentSessionRef.current !== sessionKey) return;
    for (const key of failedKeysRef.current) if (key.startsWith(itemIdentityPrefix(itemId))) failedKeysRef.current.delete(key);
    setErrorsByItemId(previous => { const next = new Map(previous); next.delete(itemId); return next; });
    setPause(null);
    enqueue([itemId]);
  }, [enqueue, isInScope, sessionKey, setPause]);

  const resume = useCallback(async () => {
    const resumeSession = currentSessionRef.current;
    if (!availableRef.current || scopeBlockedRef.current || localStopRef.current || !visibleRef.current || resumeSession !== sessionKey) return;
    const serviceIndex = metadataFreshRef.current ? indexRef.current : await refresh();
    if (!availableRef.current || scopeBlockedRef.current || resumeSession !== currentSessionRef.current || localStopRef.current || !visibleRef.current || !serviceIndex?.enabled || !serviceIndex.scope || !serviceIndex.provider.enabled || !serviceIndex.provider.model) return;
    const eligible = new Set(selectCandidateIds(serviceIndex.asOf).filter(itemId => isInScope(itemId)));
    if (updatesItemId && isInScope(updatesItemId)) eligible.add(updatesItemId);
    for (const key of failedKeysRef.current) {
      if (eligible.has(key.split('\u0000')[0])) failedKeysRef.current.delete(key);
    }
    setErrorsByItemId(previous => new Map([...previous].filter(([itemId]) => !eligible.has(itemId))));
    setPause(null);
  }, [isInScope, refresh, selectCandidateIds, sessionKey, setPause, updatesItemId]);

  const loadDetails = useCallback(async (itemId: string): Promise<AssessmentDetails | null> => {
    const detailSession = currentSessionRef.current;
    if (!availableRef.current || detailSession !== sessionKey || signingOutRef.current) return null;
    const generation = generationRef.current;
    const revision = snapshotRef.current.revision;
    detailAbortRefs.current.get(itemId)?.abort();
    const controller = new AbortController();
    detailAbortRefs.current.set(itemId, controller);
    try {
      const response = await fetch(`/api/work/assessments?itemId=${encodeURIComponent(itemId)}`, { credentials: 'same-origin', signal: controller.signal });
      const details = await parseResponse(response, body => assessmentDetailsSchema.parse(body));
      if (detailAbortRefs.current.get(itemId) !== controller || !availableRef.current || detailSession !== currentSessionRef.current || detailSession !== sessionKey || generation !== generationRef.current || revision !== snapshotRef.current.revision || signingOutRef.current) return null;
      const currentIndex = indexRef.current;
      const currentItem = snapshotRef.current.items.find(value => value.id === itemId);
      const currentInput = currentIndex?.provider.model && currentItem ? buildAssessmentInput(snapshotRef.current, itemId, currentIndex.asOf) : null;
      const currentKey = currentInput && currentIndex?.provider.model ? await assessmentInputKey(currentInput, currentIndex.provider.model) : null;
      if (detailAbortRefs.current.get(itemId) !== controller || !availableRef.current || detailSession !== currentSessionRef.current || detailSession !== sessionKey || generation !== generationRef.current || revision !== snapshotRef.current.revision || signingOutRef.current) return null;
      if (details.entry.currentInputKey && currentKey && details.entry.currentInputKey !== currentKey) {
        setDetailsByItemId(previous => { const next = new Map(previous); next.delete(itemId); return next; });
        setRefreshRequiredIds(previous => new Set(previous).add(itemId));
        return null;
      }
      if (details.sourceContext && details.record) {
        const original = buildAssessmentInput(snapshotRef.current, itemId, details.record.asOf);
        const originalKey = original ? await assessmentInputKey(original, details.record.requestTemplate.model) : null;
        if (detailAbortRefs.current.get(itemId) !== controller || !availableRef.current || detailSession !== currentSessionRef.current || detailSession !== sessionKey || generation !== generationRef.current || revision !== snapshotRef.current.revision || signingOutRef.current) return null;
        if (!original || originalKey !== details.record.inputKey) details.sourceContext = null;
      }
      if (detailAbortRefs.current.get(itemId) !== controller || !availableRef.current || detailSession !== currentSessionRef.current || detailSession !== sessionKey || generation !== generationRef.current || revision !== snapshotRef.current.revision || signingOutRef.current) return null;
      const latestEntry = indexRef.current?.entries.find(entry => entry.itemId === itemId);
      if (!latestEntry || !detailsMatchEntry(details, latestEntry)) return null;
      setDetailsByItemId(previous => new Map(previous).set(itemId, details));
      return details;
    } catch {
      return null;
    } finally {
      if (detailSession === currentSessionRef.current && detailSession === sessionKey && detailAbortRefs.current.get(itemId) === controller) detailAbortRefs.current.delete(itemId);
    }
  }, [sessionKey]);

  return {
    index,
    entriesByItemId,
    summariesByItemId,
    detailsByItemId,
    candidateIds: currentIds,
    runCandidateIds: schedulingIds,
    scope: index?.scope ?? null,
    scopeItemIds,
    savingScope,
    scopeError,
    setScope,
    serverAsOf: index?.asOf ?? null,
    enabled: index?.enabled ?? false,
    provider: index?.provider ?? { enabled: false, model: null },
    loading,
    pendingIds,
    errorsByItemId,
    pausedError,
    locallyStopped: locallyStoppedState,
    refreshRequiredIds,
    setEnabled,
    retryItem,
    resume,
    refresh,
    loadDetails,
  };
}
