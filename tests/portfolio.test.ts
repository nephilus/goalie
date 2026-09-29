import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyItem, emptyTimeWindow, importWorkDataSchema, planningOptionSchema, timeWindowSchema, type PortfolioDecision, type WorkData } from '../app/shared/model';
import { decisionReviewReasons, evidenceIsStale, portfolioSourceText, windowRelationship } from '../app/shared/portfolio';

function fixture(): WorkData {
  const at = '2026-09-01T00:00:00Z';
  return { schemaVersion: 2, revision: 7, demo: false, people: [{ id: 'lead', name: 'Lead', email: 'lead@example.test', team: 'Delivery', role: 'admin' }], workstreams: [{ id: 'delivery', title: 'Delivery', description: '', ownerId: 'lead', priority: 'high', targetDate: null, archived: false }], items: [{ ...emptyItem('delivery'), id: 'gate', title: 'Readiness gate', kind: 'milestone', createdAt: at, updatedAt: at, completedAt: null }], dependencies: [], updates: [], changes: [], outcomes: [{ id: 'outcome', workstreamId: 'delivery', title: 'Launch service', description: 'Use a temporary adapter until the common interface is ready.', ownerId: 'lead', priority: 'high', status: 'planned', window: emptyTimeWindow(), itemIds: ['gate'], createdAt: at, updatedAt: at }], capabilities: [], signals: [], opportunities: [], decisions: [], commitments: [] };
}
function independentOption() {
  return { id: 'independent', title: 'Deliver independently', strategy: 'independent' as const, benefits: 'Protect delivery', tradeoffs: 'Some duplicated work', deliveryImpact: '', resourceImpact: '', coordinationCost: '', reversibility: '', migrationObligation: '', assumptions: [], window: emptyTimeWindow(), dependencies: [] };
}

test('importing a version-one register preserves work without inventing portfolio commitments', () => {
  const { outcomes: _outcomes, capabilities: _capabilities, signals: _signals, opportunities: _opportunities, decisions: _decisions, commitments: _commitments, ...register } = fixture();
  const imported = importWorkDataSchema.parse({ ...register, schemaVersion: 1 });
  assert.equal(imported.schemaVersion, 2);
  assert.equal(imported.items[0].id, 'gate');
  assert.equal(imported.revision, 7);
  assert.deepEqual([imported.outcomes, imported.capabilities, imported.signals, imported.opportunities, imported.decisions, imported.commitments], [[], [], [], [], [], []]);
});

test('unknown timing is not a schedule gap and forecast bounds remain distinct from commitments', () => {
  const needed = { start: '2026-09-01', end: '2026-09-30', certainty: 'committed' as const, note: 'Customer delivery window' };
  assert.equal(windowRelationship(needed, emptyTimeWindow()), 'unknown');
  assert.equal(windowRelationship(needed, { start: '2026-10-01', end: '2026-12-31', certainty: 'forecast', note: 'Estimated shared readiness' }), 'gap');
  assert.equal(windowRelationship(needed, { start: '2026-08-01', end: '2026-08-31', certainty: 'forecast', note: '' }), 'ready_before_need');
  assert.equal(timeWindowSchema.safeParse({ ...needed, end: '2026-08-31' }).success, false);
  assert.equal(timeWindowSchema.safeParse({ ...needed, certainty: 'unknown' }).success, false);
  assert.equal(timeWindowSchema.safeParse({ ...emptyTimeWindow(), certainty: 'committed' }).success, false);
});

test('independent and deferred options cannot smuggle execution dependencies and bridges need an exit obligation', () => {
  const edge = { predecessorId: 'a', successorId: 'b', activation: 'now', activateOn: null, milestoneId: null };
  assert.equal(planningOptionSchema.safeParse({ ...independentOption(), dependencies: [edge] }).success, false);
  assert.equal(planningOptionSchema.safeParse({ ...independentOption(), strategy: 'revisit', dependencies: [edge] }).success, false);
  assert.equal(planningOptionSchema.safeParse({ ...independentOption(), strategy: 'temporary_bridge' }).success, false);
  assert.equal(planningOptionSchema.safeParse({ ...independentOption(), strategy: 'temporary_bridge', migrationObligation: 'Retire the adapter after interface acceptance.' }).success, true);
});

test('changed evidence and completed gates reopen review without overwriting the original decision', () => {
  const data = fixture();
  const reference = { sourceType: 'outcome' as const, sourceId: 'outcome', quote: 'Use a temporary adapter' };
  const decision: PortfolioDecision = { id: 'decision', opportunityId: 'opportunity', ownerId: 'lead', rationale: 'Protect the launch while readiness is uncertain.', reviewDate: '2026-10-01', reviewMilestoneId: 'gate', reviewNote: '', transitionWindow: emptyTimeWindow(), option: independentOption(), opportunityTitle: 'Shared interface', evidence: [{ ...reference, sourceText: portfolioSourceText(data, reference)! }], outcomeIds: ['outcome', 'other'], status: 'active', decidedBy: 'lead', decidedAt: '2026-09-01T00:00:00Z' };
  assert.deepEqual(decisionReviewReasons(data, decision, '2026-09-15'), []);
  data.outcomes[0].description = 'The common interface is now available.';
  data.items[0].status = 'done';
  assert.deepEqual(decisionReviewReasons(data, decision, '2026-10-01'), ['Review date reached', 'Review milestone completed', 'Supporting evidence changed']);
  assert.match(decision.evidence[0].sourceText, /Use a temporary adapter/);
  assert.equal(decision.option.strategy, 'independent');
  assert.deepEqual(decisionReviewReasons(data, { ...decision, status: 'superseded' }, '2026-10-01'), []);
});

test('evidence survives JSONB object key ordering without a false review trigger', () => {
  const data = fixture();
  const reference = { sourceType: 'outcome' as const, sourceId: 'outcome' };
  const captured = portfolioSourceText(data, reference);
  const previous = data.outcomes[0].window;
  data.outcomes[0].window = { note: previous.note, certainty: previous.certainty, end: previous.end, start: previous.start };
  assert.equal(portfolioSourceText(data, reference), captured);
  data.outcomes[0].window.note = 'Readiness estimate changed';
  assert.notEqual(portfolioSourceText(data, reference), captured);
});

test('manual discovery tags are excluded from item evidence and preserve legacy snapshots', () => {
  const legacy = fixture();
  Reflect.deleteProperty(legacy.items[0], 'tags');
  const reference = { sourceType: 'item' as const, sourceId: 'gate', quote: 'Readiness gate' };
  const evidence = { ...reference, sourceText: portfolioSourceText(legacy, reference)! };
  const upgraded = importWorkDataSchema.parse(legacy);
  assert.equal(evidenceIsStale(upgraded, evidence), false);
  upgraded.items[0].tags = ['identity'];
  assert.equal(evidenceIsStale(upgraded, evidence), false);
  assert.equal(portfolioSourceText(upgraded, reference)?.includes('tags:'), false);
  upgraded.items[0].description = 'Readiness now requires an additional review.';
  assert.equal(evidenceIsStale(upgraded, evidence), true);
});
