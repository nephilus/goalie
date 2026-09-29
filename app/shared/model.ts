import { z } from 'zod';
import { MAX_TAGS_PER_ITEM, normalizeTag } from './tags';

export const statuses = ['planned', 'in_progress', 'in_review', 'done', 'cancelled'] as const;
export const priorities = ['urgent', 'high', 'normal', 'low'] as const;
export const roles = ['admin', 'editor', 'viewer'] as const;
export const idSchema = z.string().min(1).max(100);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const d = new Date(`${value}T00:00:00Z`); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value; }, 'Use a valid calendar date');
const nullableId = idSchema.nullable();
const date = dateSchema.nullable();
export const personSchema = z.object({ id: idSchema, name: z.string().trim().min(1).max(100), email: z.email().max(254), team: z.string().trim().max(100), role: z.enum(roles) }).strict();
export const workstreamSchema = z.object({ id: idSchema, title: z.string().trim().min(1).max(200), description: z.string().max(10000), ownerId: nullableId, priority: z.enum(priorities), targetDate: date, archived: z.boolean() }).strict();
export const tagSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeTag(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid tag' });
    return z.NEVER;
  }
});
export const tagsSchema = z.array(tagSchema).max(MAX_TAGS_PER_ITEM).superRefine((tags, ctx) => {
  const seen = new Set<string>();
  tags.forEach((tag, index) => {
    if (seen.has(tag)) ctx.addIssue({ code: 'custom', message: 'Tags must be unique after normalization', path: [index] });
    seen.add(tag);
  });
});
export const itemSchema = z.object({ id: idSchema, title: z.string().trim().min(1).max(200), description: z.string().max(20000), workstreamId: idSchema, kind: z.enum(['task', 'milestone']), status: z.enum(statuses), priority: z.enum(priorities), ownerId: nullableId, assigneeIds: z.array(idSchema).max(50), tags: tagsSchema.default([]), plannedStart: date, plannedEnd: date, targetDate: date, blocker: z.string().max(4000), externalUrl: z.union([z.literal(''), z.url().refine(value => ['http:', 'https:'].includes(new URL(value).protocol), 'Only HTTP(S) links are allowed')]), sortOrder: z.number().int().min(0).max(1000000), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), completedAt: z.iso.datetime().nullable() }).strict();
export const dependencySchema = z.object({ predecessorId: idSchema, successorId: idSchema }).strict();
export const updateSchema = z.object({ id: idSchema, itemId: idSchema, authorId: idSchema, body: z.string().trim().min(1).max(10000), createdAt: z.iso.datetime() }).strict();
export const changeSchema = z.object({ id: idSchema, actorId: idSchema, action: z.string(), entityId: z.string().nullable(), summary: z.string(), detail: z.record(z.string(), z.json()).default({}), createdAt: z.iso.datetime() }).strict();

export const timeWindowSchema = z.object({ start: date, end: date, certainty: z.enum(['unknown', 'forecast', 'committed']), note: z.string().max(1000) }).strict().superRefine((window, ctx) => {
  if (window.start && window.end && window.start > window.end) ctx.addIssue({ code: 'custom', message: 'Window start must not follow its end', path: ['end'] });
  if (window.certainty === 'unknown' && (window.start || window.end)) ctx.addIssue({ code: 'custom', message: 'Dated windows must be marked forecast or committed', path: ['certainty'] });
  if (window.certainty !== 'unknown' && !window.start && !window.end) ctx.addIssue({ code: 'custom', message: 'Provide a boundary or mark the window unknown', path: ['certainty'] });
});
export type TimeWindow = z.infer<typeof timeWindowSchema>;
export const emptyTimeWindow = (): TimeWindow => ({ start: null, end: null, certainty: 'unknown', note: '' });
const recordTimes = { createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() };
export const outcomeInputSchema = z.object({ workstreamId: idSchema, title: z.string().trim().min(1).max(200), description: z.string().max(10000), ownerId: nullableId, priority: z.enum(priorities), status: z.enum(['planned', 'active', 'achieved', 'cancelled']), window: timeWindowSchema, itemIds: z.array(idSchema).max(200) }).strict();
export const outcomeSchema = outcomeInputSchema.extend({ id: idSchema, ...recordTimes });
export const capabilityInputSchema = z.object({ name: z.string().trim().min(1).max(200), description: z.string().max(10000) }).strict();
export const capabilitySchema = capabilityInputSchema.extend({ id: idSchema, ...recordTimes });
export const signalInputSchema = z.object({ outcomeId: idSchema, capabilityId: idSchema, direction: z.enum(['requires', 'produces']), scope: z.string().trim().max(500), window: timeWindowSchema, note: z.string().max(4000) }).strict();
export const signalSchema = signalInputSchema.extend({ id: idSchema, ...recordTimes });
export const evidenceInputSchema = z.object({ sourceType: z.enum(['item', 'update', 'workstream', 'outcome', 'capability', 'signal']), sourceId: idSchema, quote: z.string().trim().min(1).max(4000) }).strict();
export const evidenceSchema = evidenceInputSchema.extend({ sourceText: z.string().max(50000) });
export const plannedDependencySchema = dependencySchema.extend({ activation: z.enum(['now', 'after_date', 'after_milestone']), activateOn: date, milestoneId: nullableId }).superRefine((edge, ctx) => {
  if (edge.predecessorId === edge.successorId) ctx.addIssue({ code: 'custom', message: 'A dependency must connect different work items' });
  if (edge.activation === 'after_date' && (!edge.activateOn || edge.milestoneId)) ctx.addIssue({ code: 'custom', message: 'A date condition needs a date and no milestone' });
  if (edge.activation === 'after_milestone' && (!edge.milestoneId || edge.activateOn)) ctx.addIssue({ code: 'custom', message: 'A milestone condition needs a milestone and no date' });
  if (edge.activation === 'now' && (edge.activateOn || edge.milestoneId)) ctx.addIssue({ code: 'custom', message: 'Immediate commitments have no activation condition' });
});
export const planningStrategies = ['coordinate_now', 'independent', 'temporary_bridge', 'revisit'] as const;
export const planningOptionSchema = z.object({
  id: idSchema, title: z.string().trim().min(1).max(200), strategy: z.enum(planningStrategies),
  benefits: z.string().max(4000), tradeoffs: z.string().max(4000), deliveryImpact: z.string().max(4000),
  resourceImpact: z.string().max(4000), coordinationCost: z.string().max(4000), reversibility: z.string().max(4000),
  migrationObligation: z.string().max(4000), assumptions: z.array(z.string().min(1).max(1000)).max(20),
  window: timeWindowSchema, dependencies: z.array(plannedDependencySchema).max(50),
}).strict().superRefine((option, ctx) => {
  if ((option.strategy === 'independent' || option.strategy === 'revisit') && option.dependencies.length) ctx.addIssue({ code: 'custom', message: 'Independent or revisit choices cannot add execution dependencies', path: ['dependencies'] });
  if (option.strategy === 'temporary_bridge' && !option.migrationObligation.trim()) ctx.addIssue({ code: 'custom', message: 'A temporary bridge needs a migration or retirement obligation', path: ['migrationObligation'] });
});
export const opportunityKinds = ['reuse', 'shared_prerequisite', 'resource_contention', 'potential_duplication', 'timing_mismatch', 'staged_convergence'] as const;
export const opportunityInputSchema = z.object({
  title: z.string().trim().min(1).max(200), kind: z.enum(opportunityKinds), description: z.string().max(10000),
  outcomeIds: z.array(idSchema).min(2).max(20), capabilityIds: z.array(idSchema).max(20),
  window: timeWindowSchema, decisionBy: date, evidence: z.array(evidenceInputSchema).max(50),
  options: z.array(planningOptionSchema).min(1).max(8), questions: z.array(z.string().min(1).max(1000)).max(30),
}).strict();
export const opportunitySchema = opportunityInputSchema.extend({
  id: idSchema, evidence: z.array(evidenceSchema).max(50), origin: z.enum(['manual', 'ai']),
  status: z.enum(['open', 'dismissed', 'decided']), dismissalReason: z.string().max(4000), ...recordTimes,
});
export const decisionInputSchema = z.object({
  opportunityId: idSchema, optionId: idSchema, ownerId: idSchema, rationale: z.string().trim().min(1).max(10000),
  reviewDate: date, reviewMilestoneId: nullableId, reviewNote: z.string().max(4000), transitionWindow: timeWindowSchema,
}).strict();
export const decisionSchema = decisionInputSchema.omit({ optionId: true }).extend({
  id: idSchema, option: planningOptionSchema, opportunityTitle: z.string().max(200),
  evidence: z.array(evidenceSchema).max(50), outcomeIds: z.array(idSchema).min(2).max(20),
  status: z.enum(['active', 'superseded']), decidedBy: idSchema, decidedAt: z.iso.datetime(),
});
export const commitmentSchema = plannedDependencySchema.safeExtend({
  id: idSchema, decisionId: idSchema, status: z.enum(['planned', 'active', 'withdrawn']),
  createdAt: z.iso.datetime(), activatedAt: z.iso.datetime().nullable(),
});
export type Outcome = z.infer<typeof outcomeSchema>;
export type Capability = z.infer<typeof capabilitySchema>;
export type CapabilitySignal = z.infer<typeof signalSchema>;
export type EvidenceInput = z.infer<typeof evidenceInputSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type PlanningOption = z.infer<typeof planningOptionSchema>;
export type OpportunityInput = z.infer<typeof opportunityInputSchema>;
export type CoordinationOpportunity = z.infer<typeof opportunitySchema>;
export type PortfolioDecision = z.infer<typeof decisionSchema>;
export type DependencyCommitment = z.infer<typeof commitmentSchema>;
export const coordinationDraftSchema = z.object({ opportunities: z.array(opportunityInputSchema).max(12), questions: z.array(z.string().min(1).max(1000)).max(30) }).strict();
export type CoordinationDraft = z.infer<typeof coordinationDraftSchema>;
export const advisorEvidenceSchema = z.object({
  sourceId: idSchema,
  quote: z.string().min(1).max(4000).refine(value => value.trim().length > 0),
}).strict();
export const advisorOutputSchema = z.object({
  answer: z.object({
    text: z.string().min(1).max(4000).refine(value => value.trim().length > 0),
    evidence: z.array(advisorEvidenceSchema).min(1).max(1000),
  }).strict(),
}).strict();
export type AdvisorOutput = z.infer<typeof advisorOutputSchema>;
export type AdvisorSourceType = 'item' | 'update' | 'workstream' | 'outcome' | 'capability' | 'signal' | 'decision' | 'question';
export type AdvisorResponse = {
  answer: {
    text: string;
    evidence: Array<{
      sourceId: string;
      quote: string;
      sourceType: AdvisorSourceType;
      title: string;
      sourceText: string;
    }>;
  };
  baseRevision: number;
};
const portfolioShape = {
  outcomes: z.array(outcomeSchema).max(5000), capabilities: z.array(capabilitySchema).max(2000),
  signals: z.array(signalSchema).max(20000), opportunities: z.array(opportunitySchema).max(5000),
  decisions: z.array(decisionSchema).max(10000), commitments: z.array(commitmentSchema).max(20000),
};
export const workDataSchema = z.object({ schemaVersion: z.literal(2), revision: z.number().int().nonnegative(), demo: z.boolean(), people: z.array(personSchema).max(1000), workstreams: z.array(workstreamSchema).max(1000), items: z.array(itemSchema).max(20000), dependencies: z.array(dependencySchema).max(50000), updates: z.array(updateSchema).max(50000), changes: z.array(changeSchema).max(50000), ...portfolioShape }).strict();
const legacyImportSchema = workDataSchema.omit({ outcomes: true, capabilities: true, signals: true, opportunities: true, decisions: true, commitments: true }).extend({ schemaVersion: z.literal(1) });
export const importWorkDataSchema = z.union([workDataSchema, legacyImportSchema.transform(data => ({ ...data, schemaVersion: 2 as const, outcomes: [], capabilities: [], signals: [], opportunities: [], decisions: [], commitments: [] }))]);
export type Person = z.infer<typeof personSchema>;
export type Workstream = z.infer<typeof workstreamSchema>;
export type WorkItem = z.infer<typeof itemSchema>;
export type Dependency = z.infer<typeof dependencySchema>;
export type WorkUpdate = z.infer<typeof updateSchema>;
export type Change = z.infer<typeof changeSchema>;
export type WorkData = z.infer<typeof workDataSchema>;
export type Snapshot = { data: WorkData; user: Person; csrfToken: string; ai: { enabled: boolean; model: string | null }; };
export const itemInputSchema = itemSchema.omit({ id: true, createdAt: true, updatedAt: true, completedAt: true });
export const workstreamInputSchema = workstreamSchema.omit({ id: true });
export const personInputSchema = personSchema.omit({ id: true });
export const draftItemSchema = itemInputSchema.omit({ tags: true }).extend({ ref: idSchema, evidence: z.string().max(4000), inferredFields: z.array(z.string().max(100)).max(20) }).strict();
export const draftSchema = z.object({ items: z.array(draftItemSchema).max(50), dependencies: z.array(dependencySchema).max(100), questions: z.array(z.string().max(1000)).max(30) }).strict();
export type Draft = z.infer<typeof draftSchema>;
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item.create'), item: itemInputSchema }).strict(),
  z.object({ type: z.literal('item.update'), id: idSchema, item: itemInputSchema }).strict(),
  z.object({ type: z.literal('workstream.create'), workstream: workstreamInputSchema }).strict(),
  z.object({ type: z.literal('workstream.update'), id: idSchema, workstream: workstreamInputSchema }).strict(),
  z.object({ type: z.literal('person.create'), person: personInputSchema }).strict(),
  z.object({ type: z.literal('person.update'), id: idSchema, person: personInputSchema }).strict(),
  z.object({ type: z.literal('dependency.add'), dependency: dependencySchema }).strict(),
  z.object({ type: z.literal('dependency.remove'), dependency: dependencySchema }).strict(),
  z.object({ type: z.literal('update.add'), itemId: idSchema, body: z.string().trim().min(1).max(10000) }).strict(),
  z.object({ type: z.literal('draft.apply'), draft: draftSchema }).strict(),
  z.object({ type: z.literal('data.import'), data: importWorkDataSchema }).strict(),
  z.object({ type: z.literal('outcome.create'), outcome: outcomeInputSchema }).strict(),
  z.object({ type: z.literal('outcome.update'), id: idSchema, outcome: outcomeInputSchema }).strict(),
  z.object({ type: z.literal('capability.create'), capability: capabilityInputSchema }).strict(),
  z.object({ type: z.literal('capability.update'), id: idSchema, capability: capabilityInputSchema }).strict(),
  z.object({ type: z.literal('signal.create'), signal: signalInputSchema }).strict(),
  z.object({ type: z.literal('signal.update'), id: idSchema, signal: signalInputSchema }).strict(),
  z.object({ type: z.literal('signal.remove'), id: idSchema }).strict(),
  z.object({ type: z.literal('opportunity.create'), opportunity: opportunityInputSchema }).strict(),
  z.object({ type: z.literal('opportunity.update'), id: idSchema, opportunity: opportunityInputSchema }).strict(),
  z.object({ type: z.literal('opportunity.dismiss'), id: idSchema, reason: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ type: z.literal('coordination.apply'), draft: coordinationDraftSchema }).strict(),
  z.object({ type: z.literal('decision.record'), decision: decisionInputSchema }).strict(),
  z.object({ type: z.literal('commitment.activate'), id: idSchema }).strict(),
  z.object({ type: z.literal('commitment.withdraw'), id: idSchema }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const commandRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), command: commandSchema }).strict();
export type CommandRequest = z.infer<typeof commandRequestSchema>;
export type ReviewBrief = { generatedAt: string; summary: string; points: { text: string; itemIds: string[] }[]; };
export const reviewBriefSchema = z.object({ generatedAt: z.iso.datetime(), summary: z.string().max(10000), points: z.array(z.object({ text: z.string().max(4000), itemIds: z.array(idSchema).max(100) }).strict()).max(50) }).strict();
export const emptyItem = (workstreamId: string): z.infer<typeof itemInputSchema> => ({ title: '', description: '', workstreamId, kind: 'task', status: 'planned', priority: 'normal', ownerId: null, assigneeIds: [], tags: [], plannedStart: null, plannedEnd: null, targetDate: null, blocker: '', externalUrl: '', sortOrder: 0 });
