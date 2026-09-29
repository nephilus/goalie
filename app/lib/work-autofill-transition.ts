import { MAX_ITEM_TAGS, type ItemInput, type Snapshot } from '../shared/work';
import type { AssistSuggestion } from '../shared/work-assist';

export type AutofillOwnership = {
  modelStreamId: string | null;
  streamLocked: boolean;
  modelTagIds: string[];
  manualTagIds: string[];
  removedTagIds: string[];
};

const unique = (values: Iterable<string>): string[] => [...new Set(values)];
export function initialAutofillOwnership(draft: ItemInput): AutofillOwnership {
  return {
    modelStreamId: null,
    streamLocked: Boolean(draft.workstreamId),
    modelTagIds: [],
    manualTagIds: unique(draft.tagIds),
    removedTagIds: [],
  };
}

/** Apply one user-originated draft edit without treating model output as user input. */
export function transitionAutofillOwnership(
  previous: ItemInput,
  next: ItemInput,
  current: AutofillOwnership,
  snapshot: Snapshot,
): { draft: ItemInput; ownership: AutofillOwnership } {
  const ownership: AutofillOwnership = {
    modelStreamId: current.modelStreamId,
    streamLocked: current.streamLocked,
    modelTagIds: unique(current.modelTagIds),
    manualTagIds: unique(current.manualTagIds),
    removedTagIds: unique(current.removedTagIds),
  };
  let draft = next;
  const streamChanged = previous.workstreamId !== next.workstreamId;

  if (streamChanged) {
    ownership.streamLocked = true;
    ownership.modelStreamId = null;
    const modelTags = new Set(ownership.modelTagIds);
    ownership.modelTagIds = [];
    draft = { ...draft, tagIds: draft.tagIds.filter(tagId => !modelTags.has(tagId)) };
  }

  const previousTags = new Set(previous.tagIds);
  const nextTags = new Set(draft.tagIds);
  for (const tagId of previousTags) {
    if (!nextTags.has(tagId)) {
      if (ownership.modelTagIds.includes(tagId)) {
        ownership.modelTagIds = ownership.modelTagIds.filter(value => value !== tagId);
        ownership.removedTagIds = unique([...ownership.removedTagIds, tagId]);
      }
      if (ownership.manualTagIds.includes(tagId)) {
        ownership.manualTagIds = ownership.manualTagIds.filter(value => value !== tagId);
        ownership.removedTagIds = unique([...ownership.removedTagIds, tagId]);
      }
    }
  }
  for (const tagId of nextTags) {
    if (!previousTags.has(tagId)) {
      ownership.manualTagIds = unique([...ownership.manualTagIds, tagId]);
      ownership.removedTagIds = ownership.removedTagIds.filter(value => value !== tagId);
      const tag = snapshot.tags.find(value => value.id === tagId);
      if (ownership.modelStreamId && tag?.workstreamId === ownership.modelStreamId) {
        ownership.streamLocked = true;
        ownership.modelStreamId = null;
      }
    }
  }

  if (ownership.modelStreamId && previous.parentId !== next.parentId && next.parentId !== null) {
    ownership.streamLocked = true;
    ownership.modelStreamId = null;
  }

  return { draft, ownership };
}
export function removeModelOwnedTags(draft: ItemInput, ownership: AutofillOwnership): ItemInput {
  const modelTags = new Set(ownership.modelTagIds);
  return modelTags.size ? { ...draft, tagIds: draft.tagIds.filter(tagId => !modelTags.has(tagId)) } : draft;
}

/** Reconsider model-owned tags without erasing manual selections. */
export function prepareFieldSuggestionDraft(draft: ItemInput, ownership: AutofillOwnership): ItemInput {
  return removeModelOwnedTags(draft, ownership);
}

export function selectAutofillTags(draft: ItemInput, ownership: AutofillOwnership, suggestions: readonly AssistSuggestion[], tags: Snapshot['tags']): string[] {
  const accepted: string[] = [];
  const existing = new Set(draft.tagIds);
  for (const suggestion of suggestions) {
    if (existing.size >= MAX_ITEM_TAGS) break;
    if (suggestion.field !== 'tagIds' || existing.has(suggestion.value) || ownership.manualTagIds.includes(suggestion.value) || ownership.removedTagIds.includes(suggestion.value)) continue;
    const tag = tags.find(value => value.id === suggestion.value);
    if (!tag || tag.workstreamId !== null && tag.workstreamId !== draft.workstreamId) continue;
    accepted.push(suggestion.value);
    existing.add(suggestion.value);
  }
  return accepted;
}
