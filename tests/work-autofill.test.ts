import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyItem, itemInputSchema, type Snapshot, type Tag } from '../app/shared/work';
import type { AssistSuggestion } from '../app/shared/work-assist';
import { initialAutofillOwnership, removeModelOwnedTags, selectAutofillTags, transitionAutofillOwnership, type AutofillOwnership } from '../app/lib/work-autofill-transition';

function snapshot(tags: Tag[]): Snapshot {
  return { revision: 4, demo: false, people: [], goals: [], workstreams: [], items: [], tags, updates: [], changes: [], starredItemIds: [] };
}

function tag(id: string, workstreamId: string | null): Tag {
  return { id, name: id, description: id, workstreamId };
}

function ownership(overrides: Partial<AutofillOwnership> = {}): AutofillOwnership {
  return { modelStreamId: null, streamLocked: false, modelTagIds: [], manualTagIds: [], removedTagIds: [], ...overrides };
}

test('title edits retain manual stream and tags while preserving model ownership boundaries', () => {
  const previous = { ...emptyItem('manual-stream'), title: 'Old title', tagIds: ['manual'] };
  const next = { ...previous, title: 'New title' };
  const result = transitionAutofillOwnership(previous, next, initialAutofillOwnership(previous), snapshot([tag('manual', null)]));
  assert.equal(result.ownership.streamLocked, true);
  assert.deepEqual(result.ownership.manualTagIds, ['manual']);
  assert.deepEqual(result.draft.tagIds, ['manual']);
});

test('automatic model-tag clearing does not deny a later recomputation, while manual removal does', () => {
  const draft = { ...emptyItem('stream'), title: 'Task', tagIds: ['model-tag'] };
  const current = ownership({ modelStreamId: 'stream', modelTagIds: ['model-tag'] });
  const cleared = removeModelOwnedTags(draft, current);
  assert.deepEqual(cleared.tagIds, []);
  assert.deepEqual(current.removedTagIds, []);

  const manuallyRemoved = transitionAutofillOwnership(draft, { ...draft, tagIds: [] }, current, snapshot([tag('model-tag', 'stream')]));
  assert.deepEqual(manuallyRemoved.ownership.removedTagIds, ['model-tag']);
});

test('manual stream change removes stale model tags but preserves manual tags for recomputation', () => {
  const previous = { ...emptyItem('old-stream'), title: 'Task', tagIds: ['manual', 'model-old'] };
  const next = { ...previous, workstreamId: 'new-stream' };
  const current = ownership({ modelStreamId: 'old-stream', modelTagIds: ['model-old'], manualTagIds: ['manual'] });
  const result = transitionAutofillOwnership(previous, next, current, snapshot([tag('manual', null), tag('model-old', 'old-stream')]));
  assert.deepEqual(result.draft.tagIds, ['manual']);
  assert.deepEqual(result.ownership.modelTagIds, []);
  assert.deepEqual(result.ownership.manualTagIds, ['manual']);
  assert.deepEqual(result.ownership.removedTagIds, []);
  assert.equal(result.ownership.streamLocked, true);
});

test('explicit tag removal is remembered and explicit re-add becomes manual', () => {
  const previous = { ...emptyItem('stream'), title: 'Task', tagIds: ['model-tag'] };
  const current = ownership({ modelStreamId: 'stream', modelTagIds: ['model-tag'] });
  const removed = transitionAutofillOwnership(previous, { ...previous, tagIds: [] }, current, snapshot([tag('model-tag', 'stream')]));
  assert.deepEqual(removed.ownership.removedTagIds, ['model-tag']);
  const readded = transitionAutofillOwnership({ ...previous, tagIds: [] }, { ...previous, tagIds: ['model-tag'] }, removed.ownership, snapshot([tag('model-tag', 'stream')]));
  assert.deepEqual(readded.ownership.manualTagIds, ['model-tag']);
  assert.deepEqual(readded.ownership.removedTagIds, []);
  assert.equal(readded.ownership.streamLocked, true);
  assert.equal(readded.ownership.modelStreamId, null);
});


test('autofill fills only remaining tag capacity and leaves manual tags intact', () => {
  const manual = Array.from({ length: 19 }, (_, index) => `manual-${index}`);
  const draft = { ...emptyItem('stream'), title: 'Task', assigneeIds: ['sam'], tagIds: manual };
  const current = initialAutofillOwnership(draft);
  current.removedTagIds = ['dismissed'];
  const tags = [tag('foreign', 'other-stream'), tag('dismissed', null), tag('first', null), tag('second', 'stream')];
  const suggestions: AssistSuggestion[] = tags.map(value => ({
    field: 'tagIds', value: value.id, label: value.name, explanation: 'Fixture',
    probability: 1, alternatives: [{ value: value.id, label: value.name, probability: 1 }],
  }));
  const accepted = selectAutofillTags(draft, current, suggestions, tags);
  assert.deepEqual(accepted, ['first']);
  const filled = { ...draft, tagIds: [...draft.tagIds, ...accepted] };
  assert.deepEqual(itemInputSchema.parse(filled).tagIds, [...manual, 'first']);
  assert.deepEqual(draft.tagIds, manual);
  assert.deepEqual(selectAutofillTags(filled, initialAutofillOwnership(filled), suggestions, tags), []);
});
