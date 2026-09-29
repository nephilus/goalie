import { McpServer } from '@modelcontextprotocol/server';
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { pool } from '../server/db.server';
import { AssistError, suggestWorkFields, suggestWorkstreamGoals } from '../server/work-assist.server';
import { WorkError, executeWork, readWork } from '../server/work.server';
import { assistRequestSchema, assistResultSchema, workstreamAssistRequestSchema, type AssistRequest } from '../shared/work-assist';
import {
  commandRequestSchema,
  goalInputSchema,
  itemInputSchema,
  personInputSchema,
  personSchema,
  tagInputSchema,
  workstreamInputSchema,
  type Command,
  type Person,
  type Snapshot,
} from '../shared/work';

const identifier = z.string().trim().min(1).max(100);
const pageInputSchema = z.object({
  cursor: z.string().regex(/^\d+$/).optional().describe('Opaque page cursor returned by the previous call.'),
  limit: z.number().int().min(1).max(100).default(25).describe('Maximum records to return (1-100).'),
}).strict();
const expectedRevision = z.number().int().nonnegative().describe('Revision returned by the latest read; stale writes are rejected.');
const listWorkInputSchema = pageInputSchema.extend({
  query: z.string().trim().max(200).optional().describe('Case-insensitive text search over title and description.'),
  status: z.enum(['todo', 'doing', 'done']).optional(),
  workstreamId: identifier.optional(),
  goalId: identifier.optional(),
  assigneeId: identifier.optional(),
  tagId: identifier.optional(),
  starredOnly: z.boolean().optional().describe('Return only work starred by the configured account. Stars are private to that account.'),
}).strict();
const getWorkInputSchema = z.object({
  itemId: identifier,
  updatesLimit: z.number().int().min(1).max(100).default(50),
}).strict();

const pageOutputSchema = z.object({
  revision: z.number().int().nonnegative(),
  values: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
}).strict();
const workListOutputSchema = z.object({
  revision: z.number().int().nonnegative(),
  items: z.array(z.unknown()),
  nextCursor: z.string().nullable(),
  starredItemIds: z.array(identifier),
}).strict();
const mutationOutputSchema = z.object({
  revision: z.number().int().nonnegative(),
  id: identifier,
  value: z.unknown(),
}).strict();
const identityOutputSchema = z.object({ revision: z.number().int().nonnegative(), person: personSchema }).strict();
const getWorkOutputSchema = z.object({
  revision: z.number().int().nonnegative(),
  item: z.unknown(),
  starred: z.boolean(),
  children: z.array(z.unknown()),
  childrenTruncated: z.boolean(),
  updates: z.array(z.unknown()),
  updatesTruncated: z.boolean(),
}).strict();
const assistOutputSchema = assistResultSchema;

function principalIdFromEnv(): string {
  const value = process.env.GOALIE_MCP_PERSON_ID?.trim();
  if (!value) throw new Error('GOALIE_MCP_PERSON_ID is required; MCP will not select an administrator by default.');
  return value;
}

/** Resolve the explicitly configured principal and re-read its current role from the authoritative people table. */
export async function loadMcpPrincipal(personId = principalIdFromEnv()): Promise<Person> {
  const configuredId = personId.trim();
  if (!configuredId) throw new Error('GOALIE_MCP_PERSON_ID must not be empty.');
  const result = await pool.query<{ id: string; name: string; email: string; role: Person['role'] }>(
    'SELECT id, name, email, role FROM people WHERE id = $1',
    [configuredId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Configured MCP principal ${configuredId} was not found.`);
  return personSchema.parse({ id: row.id, name: row.name, email: row.email, role: row.role });
}

function page<T>(values: T[], cursor: string | undefined, limit: number): { values: T[]; nextCursor: string | null } {
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > values.length) throw new Error('Invalid page cursor.');
  return { values: values.slice(offset, offset + limit), nextCursor: offset + limit < values.length ? String(offset + limit) : null };
}

function jsonText(value: unknown): string {
  return JSON.stringify(value);
}
type ErrorResult = { content: [{ type: 'text'; text: string }]; isError: true };
type SuccessResult<T> = { content: [{ type: 'text'; text: string }]; structuredContent: T };

function errorResult(error: unknown): ErrorResult {
  if (error instanceof z.ZodError) {
    return { isError: true, content: [{ type: 'text', text: jsonText({ error: { status: 422, code: 'invalid_request', message: 'Request validation failed.' } }) }] };
  }
  if (error instanceof WorkError || error instanceof AssistError) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: jsonText({ error: { status: error.status ?? 500, code: error.code ?? 'request_failed', message: error.message } }),
      }],
    };
  }
  console.error('[goalie-mcp] internal_error', error instanceof Error ? error.name : 'UnknownError');
  return { isError: true, content: [{ type: 'text', text: jsonText({ error: { status: 500, code: 'internal_error', message: 'MCP operation failed.' } }) }] };
}

function success<T>(value: T): SuccessResult<T> {
  return { content: [{ type: 'text', text: jsonText(value) }], structuredContent: value };
}

async function withErrors<T>(operation: () => Promise<T>): Promise<SuccessResult<T> | ErrorResult> {
  try {
    return success(await operation());
  } catch (error) {
    return errorResult(error);
  }
}

async function readFor(personId: string): Promise<{ actor: Person; data: Snapshot }> {
  const actor = await loadMcpPrincipal(personId);
  return { actor, data: await readWork(actor) };
}

function entityFor(command: Command, before: Snapshot, after: Snapshot): { id: string; value: unknown } {
  const added = <T extends { id: string }>(beforeValues: T[], afterValues: T[]): T | undefined => {
    const old = new Set(beforeValues.map(value => value.id));
    return afterValues.find(value => !old.has(value.id));
  };
  switch (command.type) {
    case 'goal.create': {
      const value = added(before.goals, after.goals);
      if (!value) throw new Error('Created goal was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'workstream.create': {
      const value = added(before.workstreams, after.workstreams);
      if (!value) throw new Error('Created workstream was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'item.create': {
      const value = added(before.items, after.items);
      if (!value) throw new Error('Created work item was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'tag.create': {
      const value = added(before.tags, after.tags);
      if (!value) throw new Error('Created tag was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'person.create': {
      const value = added(before.people, after.people);
      if (!value) throw new Error('Created person was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'update.add': {
      const value = added(before.updates, after.updates);
      if (!value) throw new Error('Created update was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'goal.update': {
      const value = after.goals.find(candidate => candidate.id === command.id);
      if (!value) throw new Error('Updated goal was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'workstream.update': {
      const value = after.workstreams.find(candidate => candidate.id === command.id);
      if (!value) throw new Error('Updated workstream was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'item.update': {
      const value = after.items.find(candidate => candidate.id === command.id);
      if (!value) throw new Error('Updated work item was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'tag.update': {
      const value = after.tags.find(candidate => candidate.id === command.id);
      if (!value) throw new Error('Updated tag was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'person.update': {
      const value = after.people.find(candidate => candidate.id === command.id);
      if (!value) throw new Error('Updated person was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'update.edit': {
      const value = after.updates.find(candidate => candidate.id === command.id);
      if (!value) throw new Error('Edited update was not returned by the work service.');
      return { id: value.id, value };
    }
    case 'item.star':
      return { id: command.itemId, value: { itemId: command.itemId, starred: after.starredItemIds.includes(command.itemId) } };
    case 'goal.delete':
    case 'workstream.delete':
    case 'item.delete':
    case 'tag.delete':
    case 'person.delete':
    case 'update.delete':
      return { id: command.id, value: null };
  }
}

async function mutate(personId: string, request: { expectedRevision: number; command: Command }): Promise<{ revision: number; id: string; value: unknown }> {
  const actor = await loadMcpPrincipal(personId);
  const before = await readWork(actor);
  if (before.revision !== request.expectedRevision) {
    throw new WorkError('Workspace changed; read the latest revision and retry.', 409, 'revision_conflict');
  }
  const after = await executeWork(commandRequestSchema.parse(request), actor);
  const entity = entityFor(request.command, before, after);
  return { revision: after.revision, ...entity };
}

function readOnlyAnnotations() {
  return { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
}
function writeAnnotations(replacesRecord = false, nonIdempotent = false) {
  return { readOnlyHint: false, destructiveHint: replacesRecord, idempotentHint: nonIdempotent ? false : replacesRecord, openWorldHint: false } as const;
}

export function createWorkMcpServer(personId = principalIdFromEnv()): McpServer {
  const server = new McpServer({ name: 'goalie-work', version: '1.0.0' });

  server.registerTool('identity', {
    title: 'MCP identity',
    description: 'Return the explicitly configured Goalie principal and current workspace revision. The principal is re-read from the database for every call.',
    inputSchema: z.object({}).strict(),
    outputSchema: identityOutputSchema,
    annotations: readOnlyAnnotations(),
  }, async () => withErrors(async () => {
    const { actor, data } = await readFor(personId);
    return { revision: data.revision, person: actor };
  }));

  const registerList = <T>(name: string, title: string, description: string, select: (data: Snapshot) => T[]) => {
    server.registerTool(name, {
      title,
      description,
      inputSchema: pageInputSchema,
      outputSchema: pageOutputSchema,
      annotations: readOnlyAnnotations(),
    }, async ({ cursor, limit }) => withErrors(async () => {
      const { data } = await readFor(personId);
      return { revision: data.revision, ...page(select(data), cursor, limit) };
    }));
  };

  registerList('list_goals', 'List goals', 'List goals with bounded cursor pagination.', data => data.goals);
  registerList('list_workstreams', 'List workstreams', 'List workstreams with bounded cursor pagination.', data => data.workstreams);
  registerList('list_people', 'List people', 'List workspace people with bounded cursor pagination.', data => data.people);
  registerList('list_tags', 'List tags', 'List tags with bounded cursor pagination.', data => data.tags);

  server.registerTool('list_work', {
    title: 'List work items',
    description: 'Search and filter work items with bounded cursor pagination, including a private starredOnly filter. starredItemIds contains the configured account’s stars on this page. Use get_work for update history.',
    inputSchema: listWorkInputSchema,
    outputSchema: workListOutputSchema,
    annotations: readOnlyAnnotations(),
  }, async filters => withErrors(async () => {
    const { data } = await readFor(personId);
    const query = filters.query?.toLowerCase();
    const starred = new Set(data.starredItemIds);
    const values = data.items.filter(item =>
      (!query || `${item.title}\n${item.description}`.toLowerCase().includes(query)) &&
      (!filters.status || item.status === filters.status) &&
      (!filters.workstreamId || item.workstreamId === filters.workstreamId) &&
      (!filters.goalId || data.workstreams.find(stream => stream.id === item.workstreamId)?.goalIds.includes(filters.goalId)) &&
      (!filters.assigneeId || item.assigneeIds.includes(filters.assigneeId)) &&
      (!filters.tagId || item.tagIds.includes(filters.tagId)) &&
      (!filters.starredOnly || starred.has(item.id)),
    );
    const result = page(values, filters.cursor, filters.limit);
    return { revision: data.revision, items: result.values, starredItemIds: result.values.filter(item => starred.has(item.id)).map(item => item.id), nextCursor: result.nextCursor };
  }));

  server.registerTool('get_work', {
    title: 'Get work item',
    description: 'Return one work item, its direct children, typed update history, and whether the configured account has starred it.',
    inputSchema: getWorkInputSchema,
    outputSchema: getWorkOutputSchema,
    annotations: readOnlyAnnotations(),
  }, async ({ itemId, updatesLimit }) => withErrors(async () => {
    const { data } = await readFor(personId);
    const item = data.items.find(candidate => candidate.id === itemId);
    if (!item) throw new WorkError('Work item not found.', 404, 'not_found');
    const allChildren = data.items.filter(candidate => candidate.parentId === itemId);
    const children = allChildren.slice(0, 100);
    const updates = data.updates
      .filter(update => update.itemId === itemId)
      .reverse();
    return {
      revision: data.revision,
      item,
      starred: data.starredItemIds.includes(item.id),
      children,
      childrenTruncated: allChildren.length > children.length,
      updates: updates.slice(0, updatesLimit),
      updatesTruncated: updates.length > updatesLimit,
    };
  }));

  server.registerTool('set_work_star', {
    title: 'Set personal work star',
    description: 'Star or unstar work for the configured account only, including viewers. Explicit, idempotent preference; does not change the shared revision or publish an audit event. No other account ID is accepted.',
    inputSchema: z.object({ itemId: identifier, starred: z.boolean() }).strict(),
    outputSchema: mutationOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ itemId, starred }) => withErrors(async () => {
    const { actor, data } = await readFor(personId);
    const after = await executeWork({ expectedRevision: data.revision, command: { type: 'item.star', itemId, starred } }, actor);
    return { revision: after.revision, id: itemId, value: { itemId, starred: after.starredItemIds.includes(itemId) } };
  }));

  server.registerTool('suggest_work_fields', {
    title: 'Suggest work fields',
    description: 'Read-only private, self-hosted OpenJev suggestions for an unsaved work draft. Optional fields restrict inference to requested fields. Suggestions are bounded to the current workspace catalogue, never mutate records, and require the latest revision when saved through the normal work API.',
    inputSchema: assistRequestSchema,
    outputSchema: assistOutputSchema,
    annotations: { ...readOnlyAnnotations(), idempotentHint: false, openWorldHint: true },
  }, async input => withErrors(async () => {
    const actor = await loadMcpPrincipal(personId);
    return suggestWorkFields(input as AssistRequest, actor);
  }));

  server.registerTool('suggest_workstream_goals', {
    title: 'Suggest linked goals',
    description: 'Read-only private, self-hosted Jev suggestions for an unsaved workstream. Returns existing workspace goals supported by its title and description. Does not save links; use the revision-checked workstream write after review.',
    inputSchema: workstreamAssistRequestSchema,
    outputSchema: assistOutputSchema,
    annotations: { ...readOnlyAnnotations(), idempotentHint: false, openWorldHint: true },
  }, async input => withErrors(async () => {
    const actor = await loadMcpPrincipal(personId);
    return suggestWorkstreamGoals(input, actor);
  }));

  type MutationInput = {
    expectedRevision: number;
    id?: string;
    itemId?: string;
    body?: string;
    kind?: 'note' | 'blocker' | 'blocker_resolved';
    goal?: z.infer<typeof goalInputSchema>;
    workstream?: z.infer<typeof workstreamInputSchema>;
    item?: z.infer<typeof itemInputSchema>;
    tag?: z.infer<typeof tagInputSchema>;
    person?: z.infer<typeof personInputSchema>;
  };
  const registerMutation = (name: string, title: string, description: string, inputSchema: StandardSchemaWithJSON, makeCommand: (input: MutationInput) => Command, replacesRecord = false, nonIdempotent = false) => {
    server.registerTool(name, {
      title,
      description,
      inputSchema,
      outputSchema: mutationOutputSchema,
      annotations: writeAnnotations(replacesRecord, nonIdempotent),
    }, async input => withErrors(() => {
      const parsed = input as MutationInput;
      return mutate(personId, { expectedRevision: parsed.expectedRevision, command: makeCommand(parsed) });
    }));
  };

  const goalCreateInput = z.object({ expectedRevision, goal: goalInputSchema }).strict();
  const goalUpdateInput = z.object({ expectedRevision, id: identifier, goal: goalInputSchema }).strict();
  const streamCreateInput = z.object({ expectedRevision, workstream: workstreamInputSchema }).strict();
  const streamUpdateInput = z.object({ expectedRevision, id: identifier, workstream: workstreamInputSchema }).strict();
  const itemCreateInput = z.object({ expectedRevision, item: itemInputSchema }).strict();
  const itemUpdateInput = z.object({ expectedRevision, id: identifier, item: itemInputSchema }).strict();
  const tagCreateInput = z.object({ expectedRevision, tag: tagInputSchema }).strict();
  const tagUpdateInput = z.object({ expectedRevision, id: identifier, tag: tagInputSchema }).strict();
  const personCreateInput = z.object({ expectedRevision, person: personInputSchema }).strict();
  const personUpdateInput = z.object({ expectedRevision, id: identifier, person: personInputSchema }).strict();
  const updateAddInput = z.object({ expectedRevision, itemId: identifier, kind: z.enum(['note', 'blocker', 'blocker_resolved']), body: z.string().trim().min(1).max(10000) }).strict();
  const entityDeleteInput = z.object({ expectedRevision, id: identifier }).strict();
  const updateEditInput = z.object({ expectedRevision, id: identifier, body: z.string().trim().min(1).max(10000) }).strict();

  registerMutation('create_goal', 'Create goal', 'Create a goal using the shared validated work service.', goalCreateInput, input => ({ type: 'goal.create', goal: input.goal as z.infer<typeof goalInputSchema> }));
  registerMutation('update_goal', 'Update goal', 'Replace a goal using the shared validated work service.', goalUpdateInput, input => ({ type: 'goal.update', id: input.id as string, goal: input.goal as z.infer<typeof goalInputSchema> }), true);
  registerMutation('delete_goal', 'Delete goal', 'Editors and administrators may delete a goal when the shared work service confirms it has no remaining references.', entityDeleteInput, input => ({ type: 'goal.delete', id: input.id as string }), true, true);
  registerMutation('create_workstream', 'Create workstream', 'Create a workstream using the shared validated work service.', streamCreateInput, input => ({ type: 'workstream.create', workstream: input.workstream as z.infer<typeof workstreamInputSchema> }));
  registerMutation('update_workstream', 'Update workstream', 'Replace a workstream using the shared validated work service.', streamUpdateInput, input => ({ type: 'workstream.update', id: input.id as string, workstream: input.workstream as z.infer<typeof workstreamInputSchema> }), true);
  registerMutation('delete_workstream', 'Delete workstream', 'Editors and administrators may delete an empty workstream. Its goal links are removed, not the goals; work and scoped tags block deletion.', entityDeleteInput, input => ({ type: 'workstream.delete', id: input.id as string }), true, true);
  registerMutation('create_work', 'Create work item', 'Create a work item using the shared validated work service. Items may be unassigned when assigneeIds is empty.', itemCreateInput, input => ({ type: 'item.create', item: input.item as z.infer<typeof itemInputSchema> }));
  registerMutation('update_work', 'Update work item', 'Replace the full work item input using the shared validated work service. Read the item first and send all fields to avoid dropping values; assigneeIds may be empty for unassigned work.', itemUpdateInput, input => ({ type: 'item.update', id: input.id as string, item: input.item as z.infer<typeof itemInputSchema> }), true);
  registerMutation('delete_work', 'Delete work item', 'Delete a work item when the shared work service confirms it has no remaining children or updates.', entityDeleteInput, input => ({ type: 'item.delete', id: input.id as string }), true, true);
  registerMutation('create_tag', 'Create tag', 'Create a tag using the shared validated work service.', tagCreateInput, input => ({ type: 'tag.create', tag: input.tag as z.infer<typeof tagInputSchema> }));
  registerMutation('update_tag', 'Update tag', 'Replace a tag using the shared validated work service.', tagUpdateInput, input => ({ type: 'tag.update', id: input.id as string, tag: input.tag as z.infer<typeof tagInputSchema> }), true);
  registerMutation('delete_tag', 'Delete tag', 'Administrators may delete any unreferenced tag; an editor who leads its owning workstream may delete that stream’s unreferenced tag. Common tags require an administrator.', entityDeleteInput, input => ({ type: 'tag.delete', id: input.id as string }), true, true);
  registerMutation('create_person', 'Create person', 'Administrators only. Provision a person with a normalized, unique email and role through the shared revision-checked work service.', personCreateInput, input => ({ type: 'person.create', person: input.person as z.infer<typeof personInputSchema> }));
  registerMutation('update_person', 'Update person', 'Administrators only. Read the person first, then submit the full name, immutable email, and role input through the shared revision-checked work service.', personUpdateInput, input => ({ type: 'person.update', id: input.id as string, person: input.person as z.infer<typeof personInputSchema> }), true);
  registerMutation('delete_person', 'Delete person', 'Administrators only. Delete an unreferenced person, excluding the current account and the last administrator.', entityDeleteInput, input => ({ type: 'person.delete', id: input.id as string }), true, true);
  registerMutation('add_work_update', 'Add work update', 'Append a typed note, blocker, or blocker_resolved event. Blocker text is limited to 4000 characters and sets the current blocker; blocker_resolved clears it; notes leave it unchanged. All events record author, time and assignee snapshot.', updateAddInput, input => ({ type: 'update.add', itemId: input.itemId as string, kind: input.kind as 'note' | 'blocker' | 'blocker_resolved', body: input.body as string }));
  registerMutation('edit_work_update', 'Edit work update', 'Authors/admins may edit update text, preserving kind, author, timestamp and assignee snapshot. Editing the latest blocker event updates the current blocker; earlier events do not override later ones.', updateEditInput, input => ({ type: 'update.edit', id: input.id as string, body: input.body as string }));
  registerMutation('delete_work_update', 'Delete work update', 'Authors/admins may delete an update. Deleting a blocker event recomputes current state from remaining blocker history or the preserved pre-timeline baseline.', entityDeleteInput, input => ({ type: 'update.delete', id: input.id as string }), true, true);

  return server;
}

