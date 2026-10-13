import { z } from 'zod';

const id = z.string().trim().min(1).max(100);
const text = z.string().trim().min(1).max(20000);
const revision = z.number().int().nonnegative();
const mentionedPersonIds = z.array(id).max(100).refine(v => new Set(v).size === v.length, 'Duplicate mention IDs are not allowed');
export const adrIdentitySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('person'), personId: id }).strict(),
  z.object({ kind: z.literal('name'), name: z.string().trim().min(1).max(100) }).strict(),
]);
export const adrStatusSchema = z.enum(['draft', 'pending', 'approved', 'changes_requested']);
export const adrContentSchema = z.object({
  context: text, concern: text, decision: text, alternatives: text, consequences: text, downsides: text, rationale: text,
  documentUrl: z.string().trim().max(2048).url().refine(value => /^https?:\/\//i.test(value), 'Use an http(s) URL').nullable().optional(),
}).strict();
export const adrUpdateInputSchema = adrContentSchema.extend({ requester: adrIdentitySchema, approver: adrIdentitySchema, mentionedPersonIds: mentionedPersonIds.default([]) });
export const adrCreateInputSchema = adrUpdateInputSchema.extend({ itemId: id, requester: adrIdentitySchema.optional() });
export const adrApprovalSchema = z.object({ mode: z.enum(['verified', 'recorded']), actorId: id, approver: adrIdentitySchema, comment: z.string().max(10000), createdAt: z.string().max(40) }).strict();
export const adrSchema = adrUpdateInputSchema.extend({ id, itemId: id, creatorId: id, status: adrStatusSchema, revision, approval: adrApprovalSchema.nullable(), createdAt: z.string().max(40), updatedAt: z.string().max(40) });
export const adrCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('adr.create'), adr: adrCreateInputSchema }).strict(),
  z.object({ type: z.literal('adr.update'), id, adr: adrUpdateInputSchema }).strict(),
  z.object({ type: z.literal('adr.submit'), id }).strict(),
  z.object({ type: z.literal('adr.approve'), id }).strict(),
  z.object({ type: z.literal('adr.request_changes'), id, comment: z.string().trim().min(1).max(10000) }).strict(),
  z.object({ type: z.literal('adr.record_approval'), id, comment: z.string().trim().max(10000).default('') }).strict(),
]);
export const adrCommandRequestSchema = z.object({ expectedRevision: revision, command: adrCommandSchema }).strict();
const pagination = { limit: z.number().int().min(1).max(100).default(25), cursor: z.string().max(16).regex(/^(0|[1-9]\d*)$/).refine(value => Number.isSafeInteger(Number(value)), 'Cursor is out of range').optional() };
export const adrListQuerySchema = z.object({ ...pagination, search: z.string().trim().min(1).max(500).optional(), personId: id.optional(), name: z.string().trim().min(1).max(100).optional(), role: z.enum(['requester', 'approver']).optional(), status: adrStatusSchema.optional(), itemId: id.optional() }).strict();
export const adrHistoryQuerySchema = z.object({ ...pagination, adrId: id }).strict();
export const adrHistoryEntrySchema = z.object({ id, adrId: id, actorId: id, action: z.string().max(100), comment: z.string().max(10000).nullable(), revision, snapshot: adrSchema, createdAt: z.string().max(40) }).strict();
export const notificationListQuerySchema = z.object({ ...pagination, unreadOnly: z.boolean().default(false) }).strict();
export const workNotificationSchema = z.object({ id, recipientId: id, actorId: id, kind: z.enum(['approval_requested', 'approval_result', 'mention']), itemId: id, adrId: id.nullable(), updateId: id.nullable(), readAt: z.string().max(40).nullable(), invalidatedAt: z.string().max(40).nullable(), createdAt: z.string().max(40) }).strict();
export type AdrIdentity = z.infer<typeof adrIdentitySchema>;
export type Adr = z.infer<typeof adrSchema>;
export type AdrCreateInput = z.input<typeof adrCreateInputSchema>;
export type AdrUpdateInput = z.input<typeof adrUpdateInputSchema>;
export type AdrCommandRequest = z.input<typeof adrCommandRequestSchema>;
export type AdrListQuery = z.input<typeof adrListQuerySchema>;
export type AdrHistoryQuery = z.input<typeof adrHistoryQuerySchema>;
export type AdrHistoryEntry = z.infer<typeof adrHistoryEntrySchema>;
export type NotificationListQuery = z.input<typeof notificationListQuerySchema>;
export type WorkNotification = z.infer<typeof workNotificationSchema>;
export interface AdrPage<T> { revision: number; items: T[]; nextCursor: string | null }
export interface AdrMutationResult { revision: number; adr: Adr }
