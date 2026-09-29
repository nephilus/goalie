import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assistRequestSchema, workstreamAssistRequestSchema, type AssistDraft } from '../app/shared/work-assist';
import { assistResultFromResponse, assistStatus, planAssistQuestions, validateSystemOneResponse, type AssistQuestion, type OpenJevRequest } from '../app/server/work-assist.server';
import { emptyItem, type Snapshot } from '../app/shared/work';

function snapshot(): Snapshot {
  return {
    revision: 12,
    demo: true,
    people: [
      { id: 'sam', name: 'Sam Rivera', email: 'sam@example.test', role: 'editor' },
      { id: 'lead', name: 'Platform Lead', email: 'lead@example.test', role: 'editor' },
    ],
    goals: [{ id: 'goal-1', title: 'Pilot routing', description: 'Validate routing.', targetDate: null }],
    workstreams: [{ id: 'stream', title: 'Platform', description: 'Platform delivery.', leadId: 'lead', goalIds: ['goal-1'] }],
    items: [],
    tags: [
      { id: 'shared', name: 'Pilot', description: 'Pilot work.', workstreamId: null },
      { id: 'foreign', name: 'Other stream', description: 'Other work.', workstreamId: 'other' },
    ],
    updates: [],
    changes: [],
    starredItemIds: [],
  };
}

function draft(overrides: Partial<AssistDraft> = {}): AssistDraft {
  return { ...emptyItem('stream'), title: 'Review next steps', description: 'Ask Sam Rivera to validate pilot routing.', ...overrides };
}

function choiceRequest(): OpenJevRequest {
  return {
    model: 'openjev-latest',
    state: { draft: { title: 'Review next steps' } },
    questions: {
      workstreamId: {
        type: 'choice',
        instructions: 'Choose a supplied workstream.',
        criteria: { stream: 'Platform workstream.', unknown: 'Insufficient information.' },
      },
    },
  };
}

test('assistance planning only exposes in-scope fields and explicitly named people', () => {
  const questions = planAssistQuestions(draft(), snapshot());
  assert.deepEqual(questions.map(question => question.field), ['assigneeIds', 'tagIds']);
  const people = questions.find(question => question.field === 'assigneeIds');
  assert.deepEqual(people?.options.map(option => option.value), ['sam', 'unknown']);
  const tags = questions.filter(question => question.field === 'tagIds');
  assert.deepEqual(tags.map(question => question.tagId), ['shared']);
});

test('global tags permit stream discovery while scoped tags require their owning stream', () => {
  const data = snapshot();
  const selected = draft({ workstreamId: '', tagIds: ['shared'] });
  assert.deepEqual(planAssistQuestions(selected, data).map(question => question.field), ['workstreamId']);
  for (const workstreamId of ['', 'stream']) {
    assert.throws(() => planAssistQuestions(draft({ workstreamId, tagIds: ['foreign'] }), data),
      (error: any) => error.code === 'assist_invalid_scope');
  }
  assert.throws(() => planAssistQuestions(draft({ tagIds: ['missing'] }), data),
    (error: any) => error.code === 'assist_invalid_scope');
});

test('requested fields restrict inference without bypassing scope validation', () => {
  const data = snapshot();
  const fields = ['workstreamId', 'tagIds'] as const;
  const missingStream = draft({ workstreamId: '' });
  assert.deepEqual(planAssistQuestions(missingStream, data, fields).map(question => question.field), ['workstreamId']);
  assert.deepEqual(planAssistQuestions(draft(), data, fields).map(question => question.field), ['tagIds']);
  assert.deepEqual(planAssistQuestions(missingStream, data, ['tagIds']), []);
  assert.throws(() => planAssistQuestions(draft({ tagIds: ['foreign'] }), data, fields),
    (error: any) => error.code === 'assist_invalid_scope');
  const request = { expectedRevision: 12, draft: draft() };
  assert.throws(() => assistRequestSchema.parse({ ...request, fields: ['tagIds', 'tagIds'] }));
  assert.throws(() => assistRequestSchema.parse({ ...request, fields: ['status'] }));
  assert.throws(() => assistRequestSchema.parse({ ...request, fields: ['goalIds'] }));
  assert.throws(() => assistRequestSchema.parse({ ...request, fields: [] }));
});

test('unknown model choices abstain and valid choices preserve unknown alternatives', () => {
  const questions = planAssistQuestions(draft({ workstreamId: '' }), snapshot());
  assert.deepEqual(questions.map(question => question.field), ['workstreamId']);
  const request = choiceRequest();
  const unknownResponse = validateSystemOneResponse(request, {
    model: 'openjev-0.1',
    answers: { workstreamId: { type: 'choice', choice: 'unknown', probabilities: { stream: 0, unknown: 1 } } },
  });
  const abstained = assistResultFromResponse(12, questions, unknownResponse, 347.1);
  assert.deepEqual(abstained.suggestions, []);
  assert.deepEqual(abstained.consideredFields, ['workstreamId']);

  const selectedResponse = validateSystemOneResponse(request, {
    model: 'openjev-0.1',
    answers: { workstreamId: { type: 'choice', choice: 'stream', probabilities: { stream: 0.94, unknown: 0.06 } } },
  });
  const selected = assistResultFromResponse(12, questions, selectedResponse, 365.2);
  assert.equal(selected.suggestions[0]?.value, 'stream');
  assert.equal(selected.suggestions[0]?.alternatives.find(option => option.value === 'unknown')?.probability, 0.06);
});

test('assistance rejects malformed IDs, types, probabilities, and answer counts before mapping', () => {
  const request = choiceRequest();
  const valid = { model: 'openjev-0.1', answers: { workstreamId: { type: 'choice', choice: 'stream', probabilities: { stream: 0.9, unknown: 0.1 } } } };
  const validResponse = validateSystemOneResponse(request, valid);
  assert.equal(validResponse.model, 'openjev-0.1');
  const invalidResponses = [
    { ...valid, answers: { wrong: valid.answers.workstreamId } },
    { ...valid, answers: { workstreamId: { ...valid.answers.workstreamId, type: 'noul' } } },
    { ...valid, answers: { workstreamId: { ...valid.answers.workstreamId, probabilities: { stream: 0.4, unknown: 0.4 } } } },
    { ...valid, answers: { workstreamId: { ...valid.answers.workstreamId, choice: 'unknown', probabilities: { stream: 0.9, unknown: 0.1 } } } },
  ];
  for (const invalid of invalidResponses) assert.throws(() => validateSystemOneResponse(request, invalid), /local model/i);
});

test('assistance request schema allows an incomplete title and unselected workstream only', () => {
  const parsed = assistRequestSchema.parse({ expectedRevision: 12, draft: { ...emptyItem(''), title: '' } });
  assert.equal(parsed.draft.title, '');
  assert.equal(parsed.draft.workstreamId, '');
});

test('assistance rejects removed singular assignee and goal fields', () => {
  assert.throws(() => assistRequestSchema.parse({
    expectedRevision: 12,
    draft: { ...emptyItem('stream'), title: 'Task', assigneeId: 'sam' },
  }));
  assert.throws(() => assistRequestSchema.parse({
    expectedRevision: 12,
    draft: { ...emptyItem('stream'), title: 'Task', goalId: 'goal-1' },
  }));
});

test('workstream assistance accepts incomplete titles and only workspace goal IDs', () => {
  const parsed = workstreamAssistRequestSchema.parse({
    expectedRevision: 12,
    draft: { title: '', description: 'Pilot routing', leadId: 'lead', goalIds: [] },
  });
  assert.equal(parsed.draft.title, '');
  assert.throws(() => workstreamAssistRequestSchema.parse({
    expectedRevision: 12,
    draft: { title: '', description: '', leadId: 'lead', goalIds: ['goal-1', 'goal-1'] },
  }));
  assert.throws(() => workstreamAssistRequestSchema.parse({
    expectedRevision: 12,
    draft: { title: '', description: '', leadId: 'lead', goalIds: [], extra: 'nope' },
  }));
});

test('binary goal candidates map suggest to goalIds without aliases', () => {
  const planned: AssistQuestion[] = [{
    id: 'goalIds:goal-1',
    field: 'goalIds',
    candidateId: 'goal-1',
    options: [
      { value: 'suggest', label: 'Pilot routing', description: 'Goal' },
      { value: 'unknown', label: 'Not enough information', description: 'Unknown' },
    ],
  }];
  const request: OpenJevRequest = {
    model: 'openjev-latest',
    state: { draft: { title: 'Pilot routing' } },
    questions: { 'goalIds:goal-1': { type: 'choice', instructions: 'Choose', criteria: { suggest: 'Goal', unknown: 'Unknown' } } },
  };
  const response = validateSystemOneResponse(request, {
    model: 'openjev-0.1',
    answers: { 'goalIds:goal-1': { type: 'choice', choice: 'suggest', probabilities: { suggest: 0.9, unknown: 0.1 } } },
  });
  const result = assistResultFromResponse(12, planned, response, 20);
  assert.equal(result.suggestions[0]?.field, 'goalIds');
  assert.equal(result.suggestions[0]?.value, 'goal-1');
  assert.equal(result.consideredFields[0], 'goalIds');
});

test('assistance status enforces trusted HTTPS origins and preserves loopback fixtures', async () => {
  const originalEnv = { ...process.env };
  const keyDir = await mkdtemp(join(tmpdir(), 'goalie-work-assist-'));
  const keyPath = join(keyDir, 'fixture-key');
  await writeFile(keyPath, 'fixture-secret', { mode: 0o600 });
  await chmod(keyPath, 0o600);

  const configure = (baseUrl: string, trustedOrigin?: string) => {
    process.env.OPENJEV_ENABLED = 'true';
    process.env.OPENJEV_BASE_URL = baseUrl;
    process.env.OPENJEV_API_KEY_FILE = keyPath;
    process.env.OPENJEV_MODEL = 'openjev-fixture';
    process.env.OPENJEV_TIMEOUT_MS = '2000';
    delete process.env.OPENJEV_API_KEY;
    if (trustedOrigin === undefined) delete process.env.OPENJEV_TRUSTED_ORIGIN;
    else process.env.OPENJEV_TRUSTED_ORIGIN = trustedOrigin;
  };

  try {
    configure('https://model.example.test:9443', 'https://model.example.test:9443/');
    assert.deepEqual(assistStatus(), { enabled: true, model: 'openjev-fixture' });

    configure('https://model.example.test', 'https://model.example.test:443');
    assert.deepEqual(assistStatus(), { enabled: true, model: 'openjev-fixture' });

    for (const trustedOrigin of [
      undefined,
      'https://other.example.test',
      'not-an-origin',
      'http://model.example.test',
      'https://@model.example.test',
      'https://@model.example.test/',
      'https://user:password@model.example.test/',
      'https://model.example.test/?',
      'https://model.example.test/#',
      'https://model.example.test/private/..',
      'https://user:model.example.test',
      'https://model.example.test/private',
      'https://model.example.test/?provider=fixture',
      'https://model.example.test/#provider',
    ]) {
      configure('https://model.example.test', trustedOrigin);
      assert.deepEqual(assistStatus(), { enabled: false, model: null }, `trusted origin should be rejected: ${trustedOrigin ?? 'missing'}`);
    }

    for (const baseUrl of [
      'https://@model.example.test',
      'https://@model.example.test/',
      'https://user:password@model.example.test/',
      'https://model.example.test/?',
      'https://model.example.test/#',
      'https://user:model.example.test',
      'https://model.example.test/private',
      'https://model.example.test/?provider=fixture',
      'https://model.example.test/#provider',
    ]) {
      configure(baseUrl, 'https://model.example.test');
      assert.deepEqual(assistStatus(), { enabled: false, model: null }, `base URL should be rejected: ${baseUrl}`);
    }

    configure('http://127.0.0.1:4311');
    assert.deepEqual(assistStatus(), { enabled: true, model: 'openjev-fixture' });
    configure('http://127.0.0.1:4311', 'not-an-origin');
    assert.deepEqual(assistStatus(), { enabled: true, model: 'openjev-fixture' });
    configure('http://127.0.0.1:80/');
    assert.deepEqual(assistStatus(), { enabled: true, model: 'openjev-fixture' });

    await chmod(keyPath, 0o644);
    assert.deepEqual(assistStatus(), { enabled: false, model: null }, 'API key must remain private');
    await chmod(keyPath, 0o600);

    configure('http://127.0.0.1');
    assert.deepEqual(assistStatus(), { enabled: false, model: null });
  } finally {
    process.env = { ...originalEnv };
    await rm(keyDir, { recursive: true, force: true });
  }
});
