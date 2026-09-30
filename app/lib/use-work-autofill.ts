import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { assistResultSchema, type AssistResult } from '../shared/work-assist';
import type { ItemInput, Snapshot } from '../shared/work';
import { initialAutofillOwnership, prepareFieldSuggestionDraft, removeModelOwnedTags, selectAutofillTags, transitionAutofillOwnership, type AutofillOwnership } from './work-autofill-transition';

type AutofillStatus = 'idle' | 'pending' | 'filled' | 'empty' | 'error' | 'off' | 'unavailable';
type AssistResponse = AssistResult;
type AssistFields = ['workstreamId', 'tagIds'];

type UseWorkAutofillOptions = {
  draft: ItemInput | null;
  setDraft: Dispatch<SetStateAction<ItemInput | null>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  snapshot: Snapshot;
  editorSession: number;
  active: boolean;
  canEdit: boolean;
  saving: boolean;
  csrfToken: string;
  available: boolean;
  model: string | null;
};

export type UseWorkAutofillResult = {
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  debug: boolean;
  setDebug: (value: boolean) => void;
  status: AutofillStatus;
  error: string | null;
  results: AssistResult[];
  suggestedWorkstream: boolean;
  suggestedTagIds: string[];
  changeDraft: (next: ItemInput) => void;
  completeTitle: () => void;
  retry: () => void;
};

const DEBOUNCE_MS = 650;
const ASSIST_DISABLED_STORAGE_KEY = 'goalie-jev-autofill-disabled';
const fields: AssistFields = ['workstreamId', 'tagIds'];

function draftKey(draft: ItemInput): string {
  return JSON.stringify(draft);
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : 'Suggestions are unavailable right now.';
}

async function readAssistResponse(response: Response): Promise<AssistResponse> {
  const contentType = response.headers.get('content-type') ?? '';
  const body: unknown = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
      ? body.error
      : `Request failed (${response.status})`;
    throw new Error(message);
  }
  const parsed = assistResultSchema.safeParse(body);
  if (!parsed.success) throw new Error('The assistance response was invalid.');
  return parsed.data;
}

export function useWorkAutofill({
  draft,
  setDraft,
  setDirty,
  snapshot,
  editorSession,
  active,
  canEdit,
  saving,
  csrfToken,
  available,
  model: _model,
}: UseWorkAutofillOptions): UseWorkAutofillResult {
  const [enabledState, setEnabledState] = useState(available);
  const [debug, setDebug] = useState(false);
  const [status, setStatus] = useState<AutofillStatus>(() => !available ? 'unavailable' : enabledState ? 'idle' : 'off');
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<AssistResult[]>([]);
  const [suggestedWorkstream, setSuggestedWorkstream] = useState(false);
  const [suggestedTagIds, setSuggestedTagIds] = useState<string[]>([]);

  const draftRef = useRef<ItemInput | null>(draft);
  const snapshotRef = useRef(snapshot);
  const ownershipRef = useRef<AutofillOwnership | null>(draft ? initialAutofillOwnership(draft) : null);
  const sessionRef = useRef(editorSession);
  const activeRef = useRef(active);
  const savingRef = useRef(saving);
  const canEditRef = useRef(canEdit);
  const availableRef = useRef(available);
  const enabledRef = useRef(enabledState);
  const csrfTokenRef = useRef(csrfToken);
  const sequenceRef = useRef(0);
  const requestRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inferencePendingRef = useRef(false);
  const inferenceTriggerRef = useRef<string | null>(null);
  const editVersionRef = useRef(0);
  const lastStartedVersionRef = useRef(-1);
  const lastRevisionRef = useRef(snapshot.revision);
  const lastAvailableRef = useRef(available);
  const reenablePendingRef = useRef(false);
  const wasAvailable = availableRef.current;
  const wasActive = activeRef.current;
  activeRef.current = active;
  savingRef.current = saving;
  canEditRef.current = canEdit;
  availableRef.current = available;
  enabledRef.current = enabledState;
  csrfTokenRef.current = csrfToken;
  draftRef.current = draft;
  snapshotRef.current = snapshot;

  // Guard response application during render, before cleanup effects get a chance to run.
  if (sessionRef.current !== editorSession) {
    sessionRef.current = editorSession;
    ownershipRef.current = draft ? initialAutofillOwnership(draft) : null;
    sequenceRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    inferencePendingRef.current = false;
    inferenceTriggerRef.current = null;
    editVersionRef.current = 0;
    lastStartedVersionRef.current = -1;
  }
  if (wasActive && !active) {
    sequenceRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  if (wasAvailable !== available) {
    sequenceRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimeout(timerRef.current ?? undefined);
    timerRef.current = null;
  }
  if (lastRevisionRef.current !== snapshot.revision) {
    lastRevisionRef.current = snapshot.revision;
    sequenceRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    clearTimeout(timerRef.current ?? undefined);
    timerRef.current = null;
    inferencePendingRef.current = false;
    inferenceTriggerRef.current = null;
  }

  const abortCurrent = useCallback(() => {
    sequenceRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
  }, []);

  const isCurrent = useCallback((sequence: number, expectedRevision: number, expectedDraftKey: string, expectedCsrfToken: string): boolean => (
    sequenceRef.current === sequence &&
    sessionRef.current === editorSession &&
    activeRef.current &&
    canEditRef.current &&
    availableRef.current &&
    enabledRef.current &&
    !savingRef.current &&
    snapshotRef.current.revision === expectedRevision &&
    csrfTokenRef.current === expectedCsrfToken &&
    draftRef.current !== null &&
    draftKey(draftRef.current) === expectedDraftKey
  ), [editorSession]);

  const applyResult = useCallback((result: AssistResult, stage: 'workstream' | 'fields'): { draft: ItemInput; applied: number } => {
    const currentDraft = draftRef.current;
    const ownership = ownershipRef.current;
    if (!currentDraft || !ownership) return { draft: currentDraft as ItemInput, applied: 0 };
    let nextDraft = currentDraft;
    let applied = 0;

    if (stage === 'workstream' && !ownership.streamLocked) {
      const suggestion = result.suggestions.find(value => value.field === 'workstreamId');
      const known = Boolean(suggestion && snapshotRef.current.workstreams.some(value => value.id === suggestion.value));
      if (!known && ownership.modelStreamId === currentDraft.workstreamId) {
        nextDraft = removeModelOwnedTags(nextDraft, ownership);
        ownership.modelTagIds = [];
        nextDraft = { ...nextDraft, workstreamId: '' };
        ownership.modelStreamId = null;
      } else if (known && (!currentDraft.workstreamId || ownership.modelStreamId === currentDraft.workstreamId)) {
        nextDraft = removeModelOwnedTags(nextDraft, ownership);
        ownership.modelTagIds = [];
        nextDraft = { ...nextDraft, workstreamId: suggestion!.value };
        ownership.modelStreamId = suggestion!.value;
        applied += 1;
      }
    }

    if (stage === 'fields' && nextDraft.workstreamId) {
      const oldModelTags = new Set(ownership.modelTagIds);
      if (oldModelTags.size) {
        nextDraft = { ...nextDraft, tagIds: nextDraft.tagIds.filter(tagId => !oldModelTags.has(tagId)) };
        ownership.modelTagIds = [];
      }
      const accepted = selectAutofillTags(nextDraft, ownership, result.suggestions, snapshotRef.current.tags);
      if (accepted.length) {
        nextDraft = { ...nextDraft, tagIds: [...nextDraft.tagIds, ...accepted] };
        ownership.modelTagIds = accepted;
        applied += accepted.length;
      }
      setSuggestedTagIds(accepted);
    }

    if (stage === 'workstream') setSuggestedWorkstream(Boolean(ownership.modelStreamId));
    return { draft: nextDraft, applied };
  }, []);

  const requestAssist = useCallback(async (requestDraft: ItemInput, expectedRevision: number, expectedDraftKey: string, expectedCsrfToken: string, sequence: number): Promise<AssistResponse> => {
    const controller = new AbortController();
    requestRef.current = controller;
    const response = await fetch('/api/work/assist', {
      method: 'POST',
      credentials: 'same-origin',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': expectedCsrfToken },
      body: JSON.stringify({ expectedRevision, draft: requestDraft, fields }),
    });
    const result = await readAssistResponse(response);
    if (result.baseRevision !== expectedRevision) throw new Error('The workspace changed while suggestions were generated. Refresh and review before using them.');
    if (!isCurrent(sequence, expectedRevision, expectedDraftKey, expectedCsrfToken)) throw new Error('stale');
    return result;
  }, [isCurrent]);

  const runChain = useCallback(async (version: number, force: boolean): Promise<void> => {
    const currentDraft = draftRef.current;
    const ownership = ownershipRef.current;
    if (!currentDraft || !ownership || !inferencePendingRef.current && !force || !inferenceTriggerRef.current && !force || !activeRef.current || !canEditRef.current || !availableRef.current || !enabledRef.current || savingRef.current || !currentDraft.title.trim()) return;
    if (!force && lastStartedVersionRef.current === version) return;
    lastStartedVersionRef.current = version;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    abortCurrent();
    const sequence = sequenceRef.current;
    const expectedRevision = snapshotRef.current.revision;
    const expectedCsrfToken = csrfTokenRef.current;
    let workingDraft = currentDraft;
    let chainApplied = 0;
    setStatus('pending');
    setError(null);
    setResults([]);

    try {
      const discoveringStream = !ownership.streamLocked;
      const firstDraft = discoveringStream
        ? { ...workingDraft, workstreamId: '', parentId: null, tagIds: [] }
        : prepareFieldSuggestionDraft(workingDraft, ownership);
      const firstKey = draftKey(workingDraft);
      const firstResult = await requestAssist(firstDraft, expectedRevision, firstKey, expectedCsrfToken, sequence);
      if (!isCurrent(sequence, expectedRevision, firstKey, expectedCsrfToken)) return;
      setResults([firstResult]);
      const firstStage = discoveringStream ? 'workstream' : 'fields';
      const firstApplied = applyResult(firstResult, firstStage);
      chainApplied += firstApplied.applied;
      if (draftKey(firstApplied.draft) !== draftKey(workingDraft)) {
        workingDraft = firstApplied.draft;
        draftRef.current = workingDraft;
        setDraft(workingDraft);
        setDirty(true);
      }

      if (discoveringStream && workingDraft.workstreamId) {
        const secondKey = draftKey(workingDraft);
        const secondDraft = prepareFieldSuggestionDraft(workingDraft, ownership);
        const secondResult = await requestAssist(secondDraft, expectedRevision, secondKey, expectedCsrfToken, sequence);
        if (!isCurrent(sequence, expectedRevision, secondKey, expectedCsrfToken)) return;
        setResults(previous => [...previous, secondResult].slice(-2));
        const secondApplied = applyResult(secondResult, 'fields');
        chainApplied += secondApplied.applied;
        if (draftKey(secondApplied.draft) !== draftKey(workingDraft)) {
          workingDraft = secondApplied.draft;
          draftRef.current = workingDraft;
          setDraft(workingDraft);
          setDirty(true);
        }
      }
      inferencePendingRef.current = false;
      inferenceTriggerRef.current = null;
      setSuggestedWorkstream(Boolean(ownership.modelStreamId));
      setStatus(chainApplied ? 'filled' : 'empty');
    } catch (caught) {
      if (caught instanceof Error && caught.message === 'stale') return;
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (sequenceRef.current !== sequence || !activeRef.current || !availableRef.current || !canEditRef.current || !enabledRef.current || savingRef.current) return;
      setError(errorMessage(caught));
      setStatus('error');
    } finally {
      if (sequenceRef.current === sequence) requestRef.current = null;
    }
  }, [abortCurrent, applyResult, isCurrent, requestAssist, setDirty, setDraft]);

  const schedule = useCallback((version: number) => {
    if (!availableRef.current || !activeRef.current || !canEditRef.current || !enabledRef.current || savingRef.current) return;
    clearTimeout(timerRef.current ?? undefined);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (!availableRef.current) return;
      void runChain(version, false);
    }, DEBOUNCE_MS);
  }, [runChain]);

  const changeDraft = useCallback((next: ItemInput) => {
    const previous = draftRef.current;
    if (!previous) {
      ownershipRef.current = initialAutofillOwnership(next);
      draftRef.current = next;
      setDraft(next);
      setDirty(true);
      editVersionRef.current += 1;
      const trigger = `${next.title}\u0000${next.description}\u0000${next.workstreamId}`;
      inferencePendingRef.current = Boolean(next.title.trim());
      inferenceTriggerRef.current = inferencePendingRef.current ? trigger : null;
      if (inferencePendingRef.current) schedule(editVersionRef.current);
      return;
    }
    const ownership = ownershipRef.current ?? initialAutofillOwnership(previous);
    const transitioned = transitionAutofillOwnership(previous, next, ownership, snapshotRef.current);
    let nextDraft = transitioned.draft;
    const textChanged = previous.title !== nextDraft.title || previous.description !== nextDraft.description;
    const streamChanged = previous.workstreamId !== nextDraft.workstreamId;
    if (!nextDraft.title.trim() && textChanged) {
      const hadModelStream = transitioned.ownership.modelStreamId !== null &&
        transitioned.ownership.modelStreamId === nextDraft.workstreamId;
      const modelTagIds = [...transitioned.ownership.modelTagIds];
      const cleared = removeModelOwnedTags(nextDraft, transitioned.ownership);
      if (hadModelStream || modelTagIds.length) {
        transitioned.ownership.modelStreamId = null;
        transitioned.ownership.modelTagIds = [];
        if (hadModelStream) transitioned.ownership.streamLocked = false;
        nextDraft = { ...cleared, workstreamId: hadModelStream ? '' : cleared.workstreamId };
        setSuggestedWorkstream(false);
        setSuggestedTagIds([]);
      }
    }
    if (draftKey(previous) === draftKey(nextDraft)) return;
    ownershipRef.current = transitioned.ownership;
    draftRef.current = nextDraft;
    setDraft(nextDraft);
    setDirty(true);
    editVersionRef.current += 1;
    abortCurrent();
    setError(null);
    if (textChanged || streamChanged) setResults([]);
    setStatus('idle');
    setSuggestedWorkstream(Boolean(transitioned.ownership.modelStreamId));
    setSuggestedTagIds(transitioned.ownership.modelTagIds);

    if (textChanged || streamChanged) {
      inferencePendingRef.current = Boolean(nextDraft.title.trim());
      inferenceTriggerRef.current = inferencePendingRef.current
        ? `${nextDraft.title}\u0000${nextDraft.description}\u0000${nextDraft.workstreamId}`
        : null;
    } else if (!nextDraft.title.trim()) {
      inferencePendingRef.current = false;
      inferenceTriggerRef.current = null;
    }
    if (inferencePendingRef.current && nextDraft.title.trim()) schedule(editVersionRef.current);
  }, [abortCurrent, schedule, setDirty, setDraft]);

  const completeTitle = useCallback(() => {
    if (!inferencePendingRef.current || !inferenceTriggerRef.current || !draftRef.current?.title.trim()) return;
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (lastStartedVersionRef.current !== editVersionRef.current) void runChain(editVersionRef.current, false);
  }, [runChain]);

  const retry = useCallback(() => {
    if (!draftRef.current?.title.trim()) return;
    inferencePendingRef.current = true;
    inferenceTriggerRef.current = `${draftRef.current.title}\u0000${draftRef.current.description}\u0000${draftRef.current.workstreamId}`;
    editVersionRef.current += 1;
    void runChain(editVersionRef.current, true);
  }, [runChain]);
  const setEnabled = useCallback((value: boolean) => {
    const next = value && availableRef.current;
    setEnabledState(next);
    enabledRef.current = next;
    if (!next) {
      try { window.localStorage.setItem(ASSIST_DISABLED_STORAGE_KEY, '1'); } catch { /* storage can be unavailable in hardened browsers */ }
      abortCurrent();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      inferencePendingRef.current = false;
      inferenceTriggerRef.current = null;
      setStatus(!availableRef.current ? 'unavailable' : 'off');
      setError(null);
      return;
    }
    try { window.localStorage.removeItem(ASSIST_DISABLED_STORAGE_KEY); } catch { /* storage can be unavailable in hardened browsers */ }
    setStatus('idle');
  }, [abortCurrent]);

  useEffect(() => {
    if (!available) return;
    try {
      if (window.localStorage.getItem(ASSIST_DISABLED_STORAGE_KEY) === '1') setEnabledState(false);
    } catch { /* storage can be unavailable in hardened browsers */ }
  }, [available]);
  useEffect(() => {
    const wasAvailable = lastAvailableRef.current;
    lastAvailableRef.current = available;
    if (!available) return;
    if (!wasAvailable) reenablePendingRef.current = true;
    if (!reenablePendingRef.current || !active || !canEdit || !enabledState || saving) return;
    const currentDraft = draftRef.current;
    if (!currentDraft?.title.trim()) return;
    inferencePendingRef.current = true;
    inferenceTriggerRef.current = `${currentDraft.title}\u0000${currentDraft.description}\u0000${currentDraft.workstreamId}`;
    reenablePendingRef.current = false;
    schedule(editVersionRef.current);
  }, [active, available, canEdit, enabledState, saving, schedule]);

  useEffect(() => {
    setStatus(!available ? 'unavailable' : enabledState ? 'idle' : 'off');
    setError(null);
    setResults([]);
    setSuggestedWorkstream(false);
    setSuggestedTagIds([]);
  }, [available, editorSession, enabledState]);

  useEffect(() => {
    if (!active || !canEdit || !available || !enabledState || saving) abortCurrent();
    if (!active || saving || !available || !enabledState) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
      setStatus(!available ? 'unavailable' : enabledState ? 'idle' : 'off');
    }
  }, [abortCurrent, active, available, canEdit, enabledState, editorSession, saving]);

  useEffect(() => () => {
    abortCurrent();
    clearTimeout(timerRef.current ?? undefined);
  }, [abortCurrent]);

  return {
    enabled: enabledState,
    setEnabled,
    debug,
    setDebug,
    status,
    error,
    results,
    suggestedWorkstream,
    suggestedTagIds,
    changeDraft,
    completeTitle,
    retry,
  };
}
