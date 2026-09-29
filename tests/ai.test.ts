import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { generateAdvisor, generateCoordination, generateDraft, generateReview } from '../app/server/ai.server';
import type { AiError } from '../app/server/ai.server';
import type { CoordinationDraft, CoordinationOpportunity, WorkData } from '../app/shared/model';

const originalEnv = { ...process.env };
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  process.env = { ...originalEnv };
});

function fixtureData(): WorkData {
  return {
    schemaVersion: 2,
    revision: 1,
    demo: false,
    people: [{ id: 'p1', name: 'Ada', email: 'ada@example.com', team: 'xCloud', role: 'editor' }],
    workstreams: [{ id: 'ws1', title: 'Platform', description: '', ownerId: 'p1', priority: 'normal', targetDate: null, archived: false }],
    items: [
      {
        id: 'item-1',
        title: 'Existing item',
        description: '',
        workstreamId: 'ws1',
        kind: 'task',
        status: 'in_progress',
        priority: 'normal',
        ownerId: 'p1',
        assigneeIds: ['p1'],
        tags: [],
        plannedStart: null,
        plannedEnd: null,
        targetDate: null,
        blocker: '',
        externalUrl: '',
        sortOrder: 0,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        completedAt: null,
      },
    ],
    dependencies: [],
    updates: [],
    changes: [],
    outcomes: [],
    capabilities: [],
    signals: [],
    opportunities: [],
    decisions: [],
    commitments: [],
  };
}
function coordinationData(): WorkData {
  const data = fixtureData();
  data.workstreams.push({ id: 'ws2', title: 'Delivery', description: 'Launch delivery', ownerId: 'p1', priority: 'normal', targetDate: '2026-05-31', archived: false });
  data.items.push({
    id: 'item-2',
    title: 'Launch milestone',
    description: 'Coordinate launch readiness.',
    workstreamId: 'ws2',
    kind: 'milestone',
    status: 'planned',
    priority: 'high',
    ownerId: 'p1',
    assigneeIds: ['p1'],
    tags: [],
    plannedStart: '2026-05-01',
    plannedEnd: '2026-05-31',
    targetDate: '2026-05-31',
    blocker: '',
    externalUrl: '',
    sortOrder: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
  });
  data.outcomes = [
    { id: 'outcome-1', workstreamId: 'ws1', title: 'Platform outcome', description: 'Deliver platform readiness.', ownerId: 'p1', priority: 'normal', status: 'active', window: { start: '2026-04-01', end: '2026-04-30', certainty: 'committed', note: '' }, itemIds: ['item-1'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'outcome-2', workstreamId: 'ws2', title: 'Delivery outcome', description: 'Deliver launch readiness.', ownerId: 'p1', priority: 'normal', status: 'planned', window: { start: '2026-05-01', end: '2026-05-31', certainty: 'forecast', note: '' }, itemIds: ['item-2'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  data.capabilities = [{ id: 'cap-1', name: 'Readiness', description: 'Shared readiness capability.', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }];
  data.signals = [
    { id: 'signal-1', outcomeId: 'outcome-1', capabilityId: 'cap-1', direction: 'produces', scope: 'platform', window: { start: null, end: null, certainty: 'unknown', note: '' }, note: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'signal-2', outcomeId: 'outcome-2', capabilityId: 'cap-1', direction: 'requires', scope: 'delivery', window: { start: null, end: null, certainty: 'unknown', note: '' }, note: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  ];
  return data;
}

function coordinationProposal(): CoordinationDraft {
  const unknownWindow: CoordinationDraft['opportunities'][number]['window'] = { start: null, end: null, certainty: 'unknown', note: '' };
  return {
    opportunities: [{
      title: 'Coordinate readiness',
      kind: 'shared_prerequisite',
      description: 'The outcomes share a readiness capability.',
      outcomeIds: ['outcome-1', 'outcome-2'],
      capabilityIds: ['cap-1'],
      window: { start: '2026-04-01', end: '2026-04-30', certainty: 'committed', note: '' },
      decisionBy: '2026-04-30',
      evidence: [{ sourceType: 'outcome', sourceId: 'outcome-1', quote: 'title: Platform outcome' }],
      options: [
        { id: 'now', title: 'Coordinate now', strategy: 'coordinate_now', benefits: 'Align readiness.', tradeoffs: '', deliveryImpact: '', resourceImpact: '', coordinationCost: 'low', reversibility: 'high', migrationObligation: '', assumptions: [], window: unknownWindow, dependencies: [] },
        { id: 'independent', title: 'Keep independent', strategy: 'independent', benefits: 'Avoid coupling.', tradeoffs: '', deliveryImpact: '', resourceImpact: '', coordinationCost: 'low', reversibility: 'high', migrationObligation: '', assumptions: [], window: unknownWindow, dependencies: [] },
      ],
      questions: [],
    }],
    questions: [],
  };
}

test('coordination preserves bounded cross-workstream signals and grounded temporal suggestions without mutation', async () => {
  const data = coordinationData();
  const before = structuredClone(data);
  let receivedContext: { sourceCatalog: { sourceType: string; sourceId: string }[]; capabilitySignals: { outcomeId: string }[] } | undefined;
  configure(await startFixture(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages[1].content as string;
    receivedContext = JSON.parse(prompt.split('<goalie-untrusted-coordination>')[1].split('</goalie-untrusted-coordination>')[0]);
    response.end(completion(JSON.stringify(coordinationProposal())));
  }));
  const draft = await generateCoordination('', ['outcome-1'], data);
  assert.equal(draft.opportunities[0].outcomeIds[1], 'outcome-2');
  assert.ok(receivedContext?.capabilitySignals.some(signal => signal.outcomeId === 'outcome-2'));
  assert.ok(receivedContext?.sourceCatalog.some(source => source.sourceType === 'outcome' && source.sourceId === 'outcome-1'));
  assert.deepEqual(data, before);
});

test('coordination rejects hallucinated evidence, metadata-only dates, and unsafe coupling', async () => {
  const data = coordinationData();
  let responseBody = completion(JSON.stringify(coordinationProposal()));
  configure(await startFixture((_request, response) => response.end(responseBody)));
  const hallucinated = coordinationProposal();
  hallucinated.opportunities[0].evidence[0].sourceId = 'invented-outcome';
  responseBody = completion(JSON.stringify(hallucinated));
  await assert.rejects(() => generateCoordination('Coordinate readiness.', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID' && error.status === 502);

  const metadataDate = coordinationProposal();
  metadataDate.opportunities[0].window.start = '2026-01-01';
  responseBody = completion(JSON.stringify(metadataDate));
  await assert.rejects(() => generateCoordination('Coordinate readiness.', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID' && error.status === 502);

  const unsafe = coordinationProposal();
  unsafe.opportunities[0].options[1].dependencies = [{ predecessorId: 'item-1', successorId: 'item-2', activation: 'now', activateOn: null, milestoneId: null }];
  responseBody = completion(JSON.stringify(unsafe));
  await assert.rejects(() => generateCoordination('Coordinate readiness.', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID' && error.status === 502);
});

test('shared tags cannot serve as evidence for proposed dependencies', async () => {
  const data = coordinationData();
  data.items[0].tags = ['identity'];
  const proposal = coordinationProposal();
  proposal.opportunities[0].window = { start: null, end: null, certainty: 'unknown', note: '' };
  proposal.opportunities[0].decisionBy = null;
  proposal.opportunities[0].evidence = [{ sourceType: 'item', sourceId: 'item-1', quote: 'tags: ["identity"]' }];
  proposal.opportunities[0].options[0].dependencies = [{ predecessorId: 'item-1', successorId: 'item-2', activation: 'now', activateOn: null, milestoneId: null }];
  configure(await startFixture((_request, response) => response.end(completion(JSON.stringify(proposal)))));
  await assert.rejects(() => generateCoordination('Coordinate readiness.', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
});

test('coordination suppresses unchanged dismissed proposals', async () => {
  const data = coordinationData();
  const proposal = coordinationProposal();
  data.opportunities = [{
    ...proposal.opportunities[0],
    id: 'dismissed-1',
    evidence: [],
    origin: 'ai',
    status: 'dismissed',
    dismissalReason: 'Not now',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as CoordinationOpportunity];
  configure(await startFixture((_request, response) => response.end(completion(JSON.stringify(proposal)))));
  await assert.rejects(() => generateCoordination('Coordinate readiness.', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID' && error.status === 502);
});

async function startFixture(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}/v1`;
}

function configure(baseUrl: string): void {
  process.env.AI_ENABLED = 'true';
  process.env.AI_BASE_URL = baseUrl;
  process.env.AI_API_KEY = 'test-secret';
  process.env.AI_MODEL = 'test-model';
  process.env.AI_ALLOW_HTTP = 'true';
  process.env.NODE_ENV = 'test';
  process.env.AI_TIMEOUT_MS = '2000';
}

function completion(content: string, finishReason = 'stop'): string {
  return JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion', model: 'test-model', choices: [{ index: 0, finish_reason: finishReason, logprobs: null, message: { role: 'assistant', content, refusal: null } }], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } });
}
test('advisor accepts a model-visible decision ID and returns inspectable evidence without mutation', async () => {
  const data = coordinationData();
  const proposal = coordinationProposal().opportunities[0];
  data.opportunities = [{ ...proposal, id: 'opportunity-1', evidence: [], origin: 'manual', status: 'decided', dismissalReason: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }];
  data.decisions = [{
    id: 'decision-1', opportunityId: 'opportunity-1', ownerId: 'p1', rationale: 'Keep independent until the format changes.',
    reviewDate: null, reviewMilestoneId: null, reviewNote: '', transitionWindow: { start: null, end: null, certainty: 'unknown', note: '' },
    option: proposal.options[1], opportunityTitle: proposal.title, evidence: [], outcomeIds: proposal.outcomeIds,
    status: 'active', decidedBy: 'p1', decidedAt: '2026-01-01T00:00:00.000Z',
  }];
  const before = structuredClone(data);
  configure(await startFixture(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const requestBody = JSON.parse(Buffer.concat(chunks).toString());
    const input = JSON.parse(requestBody.messages[1].content);
    const decision = input.priorDecisions[0];
    response.end(completion(JSON.stringify({
      answer: { text: 'The unchanged decision remains in force.', evidence: [{ sourceId: decision.id, quote: decision.rationale }] },
    })));
  }));
  const result = await generateAdvisor('Does our earlier decision still hold?', ['outcome-1'], data);
  const citation = result.answer.evidence[0];
  assert.equal(citation.sourceId, 'decision-1');
  assert.equal(citation.sourceType, 'decision');
  assert.ok(citation.sourceText.includes(citation.quote));
  assert.deepEqual(data, before);
});

test('shared tags expose candidate evidence without creating edges or excluding untagged matches', async () => {
  const data = coordinationData();
  data.capabilities = [];
  data.signals = [];
  data.outcomes = [data.outcomes[0]];
  data.items[0].tags = ['identity'];
  data.workstreams[1] = { ...data.workstreams[1], title: 'Federation', description: '' };
  data.items[1] = { ...data.items[1], title: 'Federation contract', description: 'Publishes login metadata.', tags: ['identity'] };
  data.workstreams.push({ ...data.workstreams[1], id: 'ws3', title: 'Verification' });
  data.items.push({ ...data.items[1], id: 'item-3', workstreamId: 'ws3', title: 'Platform readiness verification', description: 'Checks compatibility.', tags: [] });
  let citation = { sourceId: 'item-2', quote: 'description: Publishes login metadata.' };
  configure(await startFixture((_request, response) => {
    response.end(completion(JSON.stringify({ answer: { text: 'Inspect the source before deciding whether coordination is useful.', evidence: [citation] } })));
  }));
  const before = structuredClone(data);
  const tagged = await generateAdvisor('What needs attention?', ['outcome-1'], data);
  assert.equal(tagged.answer.evidence[0].sourceId, 'item-2');
  assert.deepEqual(data, before);
  citation = { sourceId: 'item-2', quote: 'tags: ["identity"]' };
  await assert.rejects(() => generateAdvisor('What needs attention?', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
  citation = { sourceId: 'item-2', quote: 'description: Publishes login metadata.' };
  data.items[1].tags = [];
  await assert.rejects(() => generateAdvisor('What needs attention?', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
  citation = { sourceId: 'item-3', quote: 'description: Checks compatibility.' };
  const untagged = await generateAdvisor('What needs attention?', ['outcome-1'], data);
  assert.equal(untagged.answer.evidence[0].sourceId, 'item-3');
  assert.deepEqual(data.dependencies, []);
});

test('advisor rejects unknown or altered citations and never retries truncated output', async () => {
  const data = coordinationData();
  let responseBody = completion(JSON.stringify({
    answer: { text: 'The answer is grounded.', evidence: [{ sourceId: 'invented', quote: 'not supplied' }] },
  }));
  let calls = 0;
  configure(await startFixture((_request, response) => {
    calls += 1;
    response.end(responseBody);
  }));
  await assert.rejects(() => generateAdvisor('What matters?', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
  responseBody = completion(JSON.stringify({
    answer: { text: 'The answer is grounded.', evidence: [{ sourceId: 'outcome-1', quote: 'title: Platform outcomes' }] },
  }));
  await assert.rejects(() => generateAdvisor('What matters?', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
  responseBody = completion(JSON.stringify({
    answer: { text: 'The answer is grounded.', evidence: [{ sourceId: 'outcome-1', quote: 'title: Platform outcome' }] },
  }), 'length');
  await assert.rejects(() => generateAdvisor('What matters?', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
  for (const invalid of [
    { answer: { text: 'Advice', evidence: [{ sourceId: 'outcome-1', quote: ' ' }] } },
    { answer: { text: ' ', evidence: [{ sourceId: 'outcome-1', quote: 'title: Platform outcome' }] } },
    { answer: { text: 'Advice', evidence: [{ sourceId: 'outcome-1', quote: 'title: Platform outcome' }] }, actions: [] },
    { answer: { text: 'Advice' }, evidence: [{ sourceId: 'outcome-1', quote: 'title: Platform outcome' }] },
  ]) {
    responseBody = completion(JSON.stringify(invalid));
    await assert.rejects(() => generateAdvisor('What matters?', ['outcome-1'], data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
  }
  assert.equal(calls, 7);
});

test('advisor rejects reserved question source collisions before inference', async () => {
  const data = coordinationData();
  data.outcomes[0].id = 'question';
  data.signals[0].outcomeId = 'question';
  let calls = 0;
  configure(await startFixture((_request, response) => {
    calls += 1;
    response.end(completion(JSON.stringify({ answer: { text: 'unused', evidence: [{ sourceId: 'question', quote: 'unused' }] } })));
  }));
  await assert.rejects(() => generateAdvisor('What matters?', ['question'], data), (error: AiError) => error.code === 'AI_CONTEXT_INVALID');
  assert.equal(calls, 0);
});

test('ambiguous same-type source IDs fail before either coordination inference path', async () => {
  const data = coordinationData();
  data.outcomes.push({ ...data.outcomes[0], description: 'A conflicting record using the same source ID.' });
  let calls = 0;
  configure(await startFixture((_request, response) => {
    calls += 1;
    response.end(completion(JSON.stringify({ answer: { text: 'Advice', evidence: [{ sourceId: 'outcome-1', quote: 'title: Platform outcome' }] } })));
  }));
  await assert.rejects(() => generateAdvisor('What matters?', ['outcome-1'], data), (error: AiError) => error.code === 'AI_CONTEXT_INVALID');
  await assert.rejects(() => generateCoordination('What matters?', ['outcome-1'], data), (error: AiError) => error.code === 'AI_CONTEXT_INVALID');
  assert.equal(calls, 0);
});


test('rejects malformed model JSON and hallucinated dependency references', async () => {
  let responseBody = completion('{not-json');
  const baseUrl = await startFixture((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(responseBody);
  });
  configure(baseUrl);

  await assert.rejects(
    () => generateDraft('Capture the deployment work.', 'ws1', fixtureData()),
    (error: AiError) => error.code === 'AI_PROVIDER_MALFORMED' && error.status === 502,
  );

  responseBody = completion(
    JSON.stringify({
      items: [],
      dependencies: [{ predecessorId: 'not-an-item', successorId: 'item-1' }],
      questions: [],
    }),
  );
  await assert.rejects(
    () => generateDraft('Capture the deployment work.', 'ws1', fixtureData()),
    (error: AiError) => error.code === 'AI_OUTPUT_INVALID' && error.status === 502,
  );
});

test('does not follow provider redirects', async () => {
  let redirectedRequestSeen = false;
  const baseUrl = await startFixture((request, response) => {
    if (request.url === '/capture') redirectedRequestSeen = true;
    response.statusCode = 302;
    response.setHeader('location', '/capture');
    response.end();
  });
  configure(baseUrl);

  await assert.rejects(
    () => generateDraft('Capture the deployment work.', 'ws1', fixtureData()),
    (error: AiError) => error.code === 'AI_PROVIDER_UNAVAILABLE' && error.status === 503,
  );
  assert.equal(redirectedRequestSeen, false);
});

test('draft generation accepts completion metadata but cannot assign manual tags', async () => {
  const data = fixtureData();
  const before = structuredClone(data);
  const { id, createdAt, updatedAt, completedAt, tags: _tags, ...input } = data.items[0];
  const proposal = { items: [{ ...input, title: 'Validate rollout', ref: 'new-check', evidence: 'Validate rollout after the existing item.', inferredFields: ['priority'] }], dependencies: [{ predecessorId: id, successorId: 'new-check' }], questions: ['Who approves the rollout?'] };
  let responseBody = completion(JSON.stringify(proposal));
  configure(await startFixture((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.end(responseBody);
  }));
  const draft = await generateDraft('Validate rollout after the existing item.', 'ws1', data);
  assert.deepEqual(draft, proposal);
  assert.deepEqual(data, before);
  responseBody = completion(JSON.stringify({ ...proposal, items: proposal.items.map(item => ({ ...item, tags: ['invented'] })) }));
  await assert.rejects(() => generateDraft('Validate rollout after the existing item.', 'ws1', data), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
});

test('review computes stale facts and rejects citations outside the snapshot', async () => {
  let citedId = 'item-1';
  let receivedFacts: { kind: string; itemId: string }[] = [];
  configure(await startFixture(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const prompt = body.messages[1].content as string;
    const context = JSON.parse(prompt.split('<goalie-untrusted-review>')[1].split('</goalie-untrusted-review>')[0]);
    receivedFacts = context.computedFacts;
    response.end(completion(JSON.stringify({ summary: 'Review the old platform work.', points: [{ text: 'No recent update.', itemIds: [citedId] }] })));
  }));
  const brief = await generateReview(fixtureData());
  assert.equal(brief.points[0].itemIds[0], 'item-1');
  assert.ok(receivedFacts.some(fact => fact.kind === 'stale' && fact.itemId === 'item-1'));
  citedId = 'invented-item';
  await assert.rejects(() => generateReview(fixtureData()), (error: AiError) => error.code === 'AI_OUTPUT_INVALID');
});

test('bounds chunked provider output and times out a silent provider', async () => {
  configure(await startFixture((_request, response) => {
    response.setHeader('content-type', 'application/json');
    response.write(' '.repeat(120_001));
    response.end(' '.repeat(120_001));
  }));
  await assert.rejects(() => generateDraft('Capture work.', 'ws1', fixtureData()), (error: AiError) => error.code === 'AI_OUTPUT_TOO_LARGE');
  configure(await startFixture(() => { /* Deliberately silent: exercise fetch cancellation against a real TCP peer. */ }));
  process.env.AI_TIMEOUT_MS = '25';
  await assert.rejects(() => generateDraft('Capture work.', 'ws1', fixtureData()), (error: AiError) => error.code === 'AI_TIMEOUT' && error.status === 504);
});
