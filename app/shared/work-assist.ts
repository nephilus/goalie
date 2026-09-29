import { z } from 'zod';
import { itemInputSchema } from './work';

export const assistFieldSchema = z.enum(['workstreamId', 'assigneeIds', 'tagIds', 'goalIds']);
export type AssistField = z.infer<typeof assistFieldSchema>;
const MAX_ASSIST_FIELDS = assistFieldSchema.options.length;
const workAssistFieldSchema = assistFieldSchema.exclude(['goalIds']);

const assistId = z.string().max(100);
const catalogueId = z.string().min(1).max(100);
const assistDraftSchema = itemInputSchema.extend({
  // Drafts may be incomplete while a user is choosing a workstream, title, or assignment.
  title: z.string().trim().max(200),
  workstreamId: assistId,
  assigneeIds: z.array(catalogueId).max(100).refine(values => new Set(values).size === values.length, 'Duplicate IDs are not allowed'),
});

export const assistRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  draft: assistDraftSchema,
  fields: z.array(workAssistFieldSchema).min(1).max(workAssistFieldSchema.options.length)
    .refine(values => new Set(values).size === values.length, 'Duplicate fields are not allowed')
    .optional(),
}).strict();

const workstreamAssistDraftSchema = z.object({
  // Workstream titles may be incomplete while the editor is being filled in.
  title: z.string().trim().max(200),
  description: z.string().max(10000),
  leadId: catalogueId.nullable(),
  goalIds: z.array(catalogueId).max(100).refine(values => new Set(values).size === values.length, 'Duplicate IDs are not allowed'),
}).strict();

export const workstreamAssistRequestSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  draft: workstreamAssistDraftSchema,
}).strict();

const alternativeSchema = z.object({
  value: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  probability: z.number().finite().min(0).max(1),
}).strict();

export const assistSuggestionSchema = z.object({
  field: assistFieldSchema,
  value: z.string().min(1).max(100),
  label: z.string().trim().min(1).max(200),
  // This text is authored by the application from the selected catalogue record;
  // SystemOne returns scores, not natural-language reasons.
  explanation: z.string().trim().min(1).max(500),
  probability: z.number().finite().min(0).max(1),
  alternatives: z.array(alternativeSchema).max(255),
}).strict();

export const assistResultSchema = z.object({
  baseRevision: z.number().int().nonnegative(),
  model: z.string().trim().min(1).max(200),
  roundtripMs: z.number().finite().min(0).max(120_000),
  suggestions: z.array(assistSuggestionSchema).max(64),
  consideredFields: z.array(assistFieldSchema).max(MAX_ASSIST_FIELDS).refine(values => new Set(values).size === values.length, 'Duplicate fields are not allowed'),
}).strict();

export type AssistDraft = z.infer<typeof assistDraftSchema>;
export type WorkstreamAssistRequest = z.infer<typeof workstreamAssistRequestSchema>;
export type AssistRequest = z.infer<typeof assistRequestSchema>;
export type AssistAlternative = z.infer<typeof alternativeSchema>;
export type AssistSuggestion = z.infer<typeof assistSuggestionSchema>;
export type AssistResult = z.infer<typeof assistResultSchema>;

export { assistDraftSchema };
