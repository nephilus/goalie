import { z } from 'zod';

export const MAX_ITEM_TAGS = 20;

const id = z.string().min(1).max(100);
const title = z.string().trim().min(1).max(200);
const personName = z.string().trim().min(1).max(100);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => { const d = new Date(value); return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value; }, 'Use a valid calendar date').nullable();
const ids = z.array(id).max(100).refine(values => new Set(values).size === values.length, 'Duplicate IDs are not allowed');
export const personSchema = z.object({ id, name: title, email: z.string(), role: z.enum(['admin', 'editor', 'viewer']) });
export const personInputSchema = z.object({ name: personName, email: z.string().trim().pipe(z.email().max(254)).transform(value => value.toLowerCase()), role: z.enum(['admin', 'editor', 'viewer']) }).strict();
export const goalInputSchema = z.object({ title, description: z.string().max(10000), targetDate: date }).strict();
export const workstreamInputSchema = z.object({ title, description: z.string().max(10000), leadId: id.nullable(), goalIds: ids }).strict();
export const itemInputSchema = z.object({ title, description: z.string().max(20000), workstreamId: id, parentId: id.nullable(), status: z.enum(['todo', 'doing', 'done']), assigneeIds: ids, dueDate: date, blocker: z.string().max(4000), tagIds: ids.max(MAX_ITEM_TAGS) }).strict();
export const tagInputSchema = z.object({ name: z.string().trim().min(1).max(40), description: z.string().trim().min(1).max(2000), workstreamId: id.nullable() }).strict();
export const goalSchema = goalInputSchema.extend({ id });
export const workstreamSchema = workstreamInputSchema.extend({ id });
export const itemSchema = itemInputSchema.extend({ id, createdAt: z.string(), updatedAt: z.string(), assigneeIds: ids });
export const tagSchema = tagInputSchema.extend({ id });
export const updateKindSchema = z.enum(['note', 'blocker', 'blocker_resolved']);
export const updateSchema = z.object({ id, itemId: id, authorId: id, body: z.string(), kind: updateKindSchema, assigneeIds: ids.nullable(), createdAt: z.string() });
export const changeSchema = z.object({ id, actorId: id, action: z.string(), entityId: id, createdAt: z.string() });
export const snapshotSchema = z.object({ revision: z.number().int().nonnegative(), demo: z.boolean(), people: z.array(personSchema), goals: z.array(goalSchema), workstreams: z.array(workstreamSchema), items: z.array(itemSchema), tags: z.array(tagSchema), updates: z.array(updateSchema), changes: z.array(changeSchema), starredItemIds: z.array(id) });
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('goal.create'), goal: goalInputSchema }).strict(),
  z.object({ type: z.literal('goal.update'), id, goal: goalInputSchema }).strict(),
  z.object({ type: z.literal('workstream.create'), workstream: workstreamInputSchema }).strict(),
  z.object({ type: z.literal('workstream.update'), id, workstream: workstreamInputSchema }).strict(),
  z.object({ type: z.literal('item.create'), item: itemInputSchema }).strict(),
  z.object({ type: z.literal('item.update'), id, item: itemInputSchema }).strict(),
  z.object({ type: z.literal('tag.create'), tag: tagInputSchema }).strict(),
  z.object({ type: z.literal('tag.update'), id, tag: tagInputSchema }).strict(),
  z.object({ type: z.literal('update.add'), itemId: id, kind: updateKindSchema, body: z.string().trim().min(1).max(10000) }).strict().superRefine((command, context) => { if (command.kind === 'blocker' && command.body.length > 4000) context.addIssue({ code: 'too_big', maximum: 4000, type: 'string', inclusive: true, origin: 'string', path: ['body'], message: 'Blocker updates cannot exceed 4000 characters' }); }),
  z.object({ type: z.literal('update.edit'), id, body: z.string().trim().min(1).max(10000) }).strict(),
  z.object({ type: z.literal('goal.delete'), id }).strict(),
  z.object({ type: z.literal('workstream.delete'), id }).strict(),
  z.object({ type: z.literal('item.delete'), id }).strict(),
  z.object({ type: z.literal('item.star'), itemId: id, starred: z.boolean() }).strict(),
  z.object({ type: z.literal('tag.delete'), id }).strict(),
  z.object({ type: z.literal('person.delete'), id }).strict(),
  z.object({ type: z.literal('update.delete'), id }).strict(),
  z.object({ type: z.literal('person.create'), person: personInputSchema }).strict(),
  z.object({ type: z.literal('person.update'), id, person: personInputSchema }).strict(),
]);
export const commandRequestSchema = z.object({ expectedRevision: z.number().int().nonnegative(), command: commandSchema }).strict();
export type Person = z.infer<typeof personSchema>;
export type Goal = z.infer<typeof goalSchema>;
export type Workstream = z.infer<typeof workstreamSchema>;
export type Item = z.infer<typeof itemSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type Update = z.infer<typeof updateSchema>;
export type Change = z.infer<typeof changeSchema>;
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Command = z.infer<typeof commandSchema>;
export type CommandRequest = z.infer<typeof commandRequestSchema>;
export type GoalInput = z.infer<typeof goalInputSchema>;
export type PersonInput = z.infer<typeof personInputSchema>;
export type WorkstreamInput = z.infer<typeof workstreamInputSchema>;
export type ItemInput = z.infer<typeof itemInputSchema>;
export type TagInput = z.infer<typeof tagInputSchema>;
export const emptyItem = (workstreamId: string): ItemInput => ({ title: '', description: '', workstreamId, parentId: null, status: 'todo', assigneeIds: [], dueDate: null, blocker: '', tagIds: [] });
