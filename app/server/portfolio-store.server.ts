import type { PoolClient } from 'pg';
import { z } from 'zod';
import { portfolioSourceText, opportunityIssues } from '../shared/portfolio';
import { evidenceInputSchema, workDataSchema, type CoordinationOpportunity, type Evidence, type EvidenceInput, type PlanningOption, type WorkData } from '../shared/model';

export type Row = Record<string, any>;
const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const json = (value: unknown): unknown => typeof value === 'string' ? JSON.parse(value) : value;
const portfolioDataSchema = workDataSchema.pick({ outcomes: true, capabilities: true, signals: true, opportunities: true, decisions: true, commitments: true });

export async function selectPortfolioData(client: PoolClient): Promise<Pick<WorkData, 'outcomes' | 'capabilities' | 'signals' | 'opportunities' | 'decisions' | 'commitments'>> {
  const outcomes = await client.query<Row>('SELECT id, workstream_id, title, description, owner_id, priority, status, window_json, item_ids_json, created_at, updated_at FROM outcomes ORDER BY created_at, id');
  const capabilities = await client.query<Row>('SELECT id, name, description, created_at, updated_at FROM capabilities ORDER BY created_at, id');
  const signals = await client.query<Row>('SELECT id, outcome_id, capability_id, direction, scope, window_json, note, created_at, updated_at FROM capability_signals ORDER BY created_at, id');
  const opportunities = await client.query<Row>('SELECT id, title, kind, description, outcome_ids_json, capability_ids_json, window_json, decision_by, evidence_json, options_json, questions_json, origin, status, dismissal_reason, created_at, updated_at FROM coordination_opportunities ORDER BY created_at, id');
  const decisions = await client.query<Row>('SELECT id, opportunity_id, owner_id, rationale, review_date, review_milestone_id, review_note, transition_window_json, option_json, opportunity_title, evidence_json, outcome_ids_json, status, decided_by, decided_at FROM portfolio_decisions ORDER BY decided_at, id');
  const commitments = await client.query<Row>('SELECT id, decision_id, predecessor_id, successor_id, activation, activate_on, milestone_id, status, created_at, activated_at FROM dependency_commitments ORDER BY created_at, id');
  return portfolioDataSchema.parse({
    outcomes: outcomes.rows.map(row => ({ id: row.id, workstreamId: row.workstream_id, title: row.title, description: row.description, ownerId: row.owner_id, priority: row.priority, status: row.status, window: json(row.window_json), itemIds: json(row.item_ids_json), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
    capabilities: capabilities.rows.map(row => ({ id: row.id, name: row.name, description: row.description, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
    signals: signals.rows.map(row => ({ id: row.id, outcomeId: row.outcome_id, capabilityId: row.capability_id, direction: row.direction, scope: row.scope, window: json(row.window_json), note: row.note, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
    opportunities: opportunities.rows.map(row => ({ id: row.id, title: row.title, kind: row.kind, description: row.description, outcomeIds: json(row.outcome_ids_json), capabilityIds: json(row.capability_ids_json), window: json(row.window_json), decisionBy: row.decision_by, evidence: json(row.evidence_json), options: json(row.options_json), questions: json(row.questions_json), origin: row.origin, status: row.status, dismissalReason: row.dismissal_reason, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })),
    decisions: decisions.rows.map(row => ({ id: row.id, opportunityId: row.opportunity_id, ownerId: row.owner_id, rationale: row.rationale, reviewDate: row.review_date, reviewMilestoneId: row.review_milestone_id, reviewNote: row.review_note, transitionWindow: json(row.transition_window_json), option: json(row.option_json), opportunityTitle: row.opportunity_title, evidence: json(row.evidence_json), outcomeIds: json(row.outcome_ids_json), status: row.status, decidedBy: row.decided_by, decidedAt: iso(row.decided_at) })),
    commitments: commitments.rows.map(row => ({ id: row.id, decisionId: row.decision_id, predecessorId: row.predecessor_id, successorId: row.successor_id, activation: row.activation, activateOn: row.activate_on, milestoneId: row.milestone_id, status: row.status, createdAt: iso(row.created_at), activatedAt: row.activated_at == null ? null : iso(row.activated_at) })),
  });
}

export function captureEvidence(data: WorkData, inputs: EvidenceInput[], outcomeIds: string[] = []): Evidence[] {
  const all = [...inputs];
  const sourceKeys = new Set(inputs.map(input => `${input.sourceType}:${input.sourceId}`));
  for (const outcomeId of outcomeIds) {
    const outcome = data.outcomes.find(row => row.id === outcomeId);
    if (outcome && !sourceKeys.has(`outcome:${outcomeId}`)) all.push({ sourceType: 'outcome', sourceId: outcomeId, quote: outcome.title });
  }
  if (all.length > 50) throw new Error('Evidence plus linked outcome snapshots exceeds 50 citations; remove redundant citations before saving.');
  return all.map(input => {
    const parsed = evidenceInputSchema.parse(input);
    const sourceText = portfolioSourceText(data, parsed);
    if (sourceText == null) throw new Error(`Evidence source ${parsed.sourceType}:${parsed.sourceId} does not exist`);
    if (!sourceText.includes(parsed.quote)) throw new Error(`Evidence quote does not occur in ${parsed.sourceType}:${parsed.sourceId}`);
    return { ...parsed, sourceText };
  });
}

export function validatePortfolioGraph(data: WorkData): void {
  const itemIds = new Set(data.items.map(item => item.id));
  const people = new Set(data.people.map(person => person.id));
  const workstreams = new Set(data.workstreams.map(stream => stream.id));
  const outcomes = new Set(data.outcomes.map(row => row.id));
  const capabilities = new Set(data.capabilities.map(row => row.id));
  for (const row of data.outcomes) {
    if (!workstreams.has(row.workstreamId) || (row.ownerId && !people.has(row.ownerId)) || row.itemIds.some(id => !itemIds.has(id))) throw new Error('Outcome references an unknown record');
  }
  for (const row of data.signals) if (!outcomes.has(row.outcomeId) || !capabilities.has(row.capabilityId)) throw new Error('Signal references an unknown record');
  for (const row of data.opportunities) {
    const issues = opportunityIssues(data, row);
    if (issues.length) throw new Error(issues.join(' '));
  }
  const activeDecisions = new Set<string>();
  const edgeMatches = (left: PlanningOption['dependencies'][number], right: PlanningOption['dependencies'][number]) =>
    left.predecessorId === right.predecessorId && left.successorId === right.successorId && left.activation === right.activation && left.activateOn === right.activateOn && left.milestoneId === right.milestoneId;
  for (const row of data.decisions) {
    if (!opportunitiesHas(data, row.opportunityId) || !people.has(row.ownerId) || !people.has(row.decidedBy) || row.outcomeIds.some(id => !outcomes.has(id))) throw new Error('Decision references an unknown record');
    if ((row.option.strategy === 'temporary_bridge' || row.option.strategy === 'revisit') && !row.reviewDate && !row.reviewMilestoneId) throw new Error('A bridge or deferred decision needs a review date or milestone');
    if (row.reviewMilestoneId && data.items.find(item => item.id === row.reviewMilestoneId)?.kind !== 'milestone') throw new Error('Decision review must reference a milestone');
    if (row.status === 'active') {
      if (activeDecisions.has(row.opportunityId)) throw new Error('An opportunity cannot have multiple active decisions');
      activeDecisions.add(row.opportunityId);
    }
    for (const edge of row.option.dependencies) {
      if (!data.commitments.some(commitment => commitment.decisionId === row.id && edgeMatches(edge, commitment))) throw new Error('Decision dependency is missing its commitment');
    }
  }
  const commitmentIds = new Set<string>();
  for (const row of data.commitments) {
    if (commitmentIds.has(row.id) || !itemIds.has(row.predecessorId) || !itemIds.has(row.successorId) || !data.decisions.some(d => d.id === row.decisionId)) throw new Error('Commitment references an unknown record');
    commitmentIds.add(row.id);
    const decision = data.decisions.find(candidate => candidate.id === row.decisionId)!;
    if (!decision.option.dependencies.some(edge => edgeMatches(edge, row))) throw new Error('Commitment does not match its approved option');
    if (row.status !== 'withdrawn' && decision.status !== 'active') throw new Error('Only active decisions may own live commitments');
    if (row.milestoneId && data.items.find(item => item.id === row.milestoneId)?.kind !== 'milestone') throw new Error('Commitment activation must reference a milestone');
    if (row.status === 'planned' && (row.activation === 'now' || row.activatedAt !== null)) throw new Error('Planned commitment has inconsistent activation history');
    if (row.status === 'active' && row.activatedAt === null) throw new Error('Active commitment needs an activation timestamp');
    if (row.activatedAt && row.activation === 'after_date' && row.activateOn && row.activatedAt.slice(0, 10) < row.activateOn) throw new Error('Commitment activated before its approved date');
    if (row.status === 'active' && !data.dependencies.some(edge => edge.predecessorId === row.predecessorId && edge.successorId === row.successorId)) throw new Error('Active commitment is missing its dependency edge');
  }
  for (const edge of data.dependencies) {
    const generated = data.commitments.filter(row => row.status === 'active' && row.predecessorId === edge.predecessorId && row.successorId === edge.successorId);
    if (generated.length > 1) throw new Error('A dependency edge has multiple active commitments');
  }
}

function opportunitiesHas(data: WorkData, id: string): boolean {
  return data.opportunities.some(row => row.id === id);
}


export function cycleWouldExist(edges: Array<{ predecessorId: string; successorId: string }>, candidate: { predecessorId: string; successorId: string }): boolean {
  const adjacency = new Map<string, string[]>();
  for (const edge of [...edges, candidate]) {
    const successors = adjacency.get(edge.predecessorId) ?? [];
    successors.push(edge.successorId);
    adjacency.set(edge.predecessorId, successors);
  }
  const seen = new Set<string>();
  const visit = (id: string): boolean => { if (id === candidate.predecessorId) return true; if (seen.has(id)) return false; seen.add(id); return (adjacency.get(id) ?? []).some(visit); };
  return visit(candidate.successorId);
}

