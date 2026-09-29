import type { CoordinationOpportunity, Evidence, EvidenceInput, OpportunityInput, PortfolioDecision, TimeWindow, WorkData } from './model';

export const opportunityKindLabels = { reuse: 'Reuse opportunity', shared_prerequisite: 'Shared prerequisite', resource_contention: 'Resource contention', potential_duplication: 'Potential duplication', timing_mismatch: 'Timing mismatch', staged_convergence: 'Staged convergence' } as const;
export const strategyLabels = { coordinate_now: 'Coordinate now', independent: 'Keep independent', temporary_bridge: 'Temporary bridge', revisit: 'Revisit later' } as const;

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => nested && typeof nested === 'object' && !Array.isArray(nested)
    ? Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)))
    : nested);
}

export function portfolioSourceText(data: WorkData, ref: Pick<EvidenceInput, 'sourceType' | 'sourceId'>): string | null {
  const records = { item: data.items, update: data.updates, workstream: data.workstreams, outcome: data.outcomes, capability: data.capabilities, signal: data.signals };
  const source = records[ref.sourceType].find(record => record.id === ref.sourceId);
  if (!source) return null;
  // Manual tags aid discovery but are never citable evidence for a relationship.
  return Object.entries(source).filter(([key]) => key !== 'tags').sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : canonicalJson(value)}`).join('\n');
}

export function evidenceIsStale(data: WorkData, evidence: Evidence): boolean {
  return portfolioSourceText(data, evidence) !== evidence.sourceText;
}

export function coordinationOpportunityFingerprint(opportunity: Pick<OpportunityInput, 'kind' | 'outcomeIds' | 'capabilityIds' | 'options'>): string {
  return JSON.stringify({
    kind: opportunity.kind,
    outcomeIds: [...opportunity.outcomeIds].sort(),
    capabilityIds: [...opportunity.capabilityIds].sort(),
    options: opportunity.options.map(option => ({
      strategy: option.strategy,
      dependencies: option.dependencies.map(edge => ({
        predecessorId: edge.predecessorId, successorId: edge.successorId, activation: edge.activation,
        activateOn: edge.activateOn, milestoneId: edge.milestoneId,
      })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  });
}

export function opportunityIssues(data: WorkData, opportunity: Pick<CoordinationOpportunity, 'outcomeIds' | 'capabilityIds' | 'options'>): string[] {
  const issues: string[] = [];
  const outcomeIds = new Set(data.outcomes.map(row => row.id));
  const capabilityIds = new Set(data.capabilities.map(row => row.id));
  const items = new Map(data.items.map(row => [row.id, row]));
  if (new Set(opportunity.outcomeIds).size !== opportunity.outcomeIds.length) issues.push('Choose distinct outcomes.');
  if (opportunity.outcomeIds.some(id => !outcomeIds.has(id))) issues.push('An outcome is no longer available.');
  if (new Set(opportunity.capabilityIds).size !== opportunity.capabilityIds.length || opportunity.capabilityIds.some(id => !capabilityIds.has(id))) issues.push('Choose distinct existing capabilities.');
  if (new Set(opportunity.options.map(option => option.id)).size !== opportunity.options.length) issues.push('Option IDs must be distinct.');
  for (const option of opportunity.options) {
    const pairs = new Set<string>();
    for (const edge of option.dependencies) {
      const key = JSON.stringify([edge.predecessorId, edge.successorId]);
      if (pairs.has(key)) issues.push('An option repeats an execution dependency.');
      pairs.add(key);
      if (!items.has(edge.predecessorId) || !items.has(edge.successorId)) issues.push('An option refers to unavailable work.');
      if (edge.milestoneId && items.get(edge.milestoneId)?.kind !== 'milestone') issues.push('Activation conditions must refer to an existing milestone.');
    }
  }
  return issues;
}

export function decisionReviewReasons(data: WorkData, decision: PortfolioDecision, today = new Date().toISOString().slice(0, 10)): string[] {
  if (decision.status !== 'active') return [];
  const reasons: string[] = [];
  if (decision.reviewDate && decision.reviewDate <= today) reasons.push('Review date reached');
  if (decision.reviewMilestoneId) {
    const milestone = data.items.find(item => item.id === decision.reviewMilestoneId);
    if (!milestone) reasons.push('Review milestone unavailable');
    else if (milestone.status === 'done') reasons.push('Review milestone completed');
    else if (milestone.status === 'cancelled') reasons.push('Review milestone cancelled');
  }
  if (decision.evidence.some(evidence => evidenceIsStale(data, evidence))) reasons.push('Supporting evidence changed');
  return reasons;
}

export function windowLabel(window: TimeWindow): string {
  const dates = window.start && window.end ? window.start === window.end ? window.start : `${window.start} – ${window.end}` : window.start ? `From ${window.start}` : window.end ? `By ${window.end}` : 'Timing unknown';
  return `${dates}${window.certainty === 'unknown' ? '' : ` · ${window.certainty === 'committed' ? 'Committed' : 'Forecast'}`}${window.note ? ` · ${window.note}` : ''}`;
}

export function windowRelationship(required: TimeWindow, available: TimeWindow): 'unknown' | 'gap' | 'ready_before_need' | 'overlap' {
  if (required.certainty === 'unknown' || available.certainty === 'unknown') return 'unknown';
  if (required.end && available.start && available.start > required.end) return 'gap';
  if (required.start && available.end && available.end < required.start) return 'ready_before_need';
  if (required.start && required.end && available.start && available.end) return 'overlap';
  return 'unknown';
}
