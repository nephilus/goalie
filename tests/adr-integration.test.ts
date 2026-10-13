import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { z } from 'zod';
import { emptyItem, type Person } from '../app/shared/work';
import {
  adrSchema, adrHistoryEntrySchema, workNotificationSchema, adrUpdateInputSchema,
  type Adr, type AdrCreateInput,
} from '../app/shared/adr';

const revision = z.number().int().nonnegative();
const adrResult = z.object({ revision, adr: adrSchema }).strict();
const adrPage = z.object({ revision, items: z.array(adrSchema), nextCursor: z.string().nullable() }).strict();
const historyPage = z.object({ revision, items: z.array(adrHistoryEntrySchema), nextCursor: z.string().nullable() }).strict();
const notificationsPage = z.object({ revision, items: z.array(workNotificationSchema), nextCursor: z.string().nullable() }).strict();
const workMutation = z.object({ revision, id: z.string(), value: z.unknown() });
const content = {
  context: 'Synchronous ingestion', concern: 'Peak latency', decision: 'Adopt bounded queues',
  alternatives: 'Scale workers', consequences: 'Eventual completion', downsides: 'Queue operations', rationale: 'Predictable limits',
};
const person = (personId: string) => ({ kind: 'person' as const, personId });

// The SDK communicates over real linked transports. Every database table lives
// in a unique disposable schema, never in the caller's workspace schema.
test('ADR MCP lifecycle, authorization, immutable history, private notifications and work compatibility', { skip: !process.env.WORK_TEST_DATABASE_URL }, async t => {
  const url = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `adr_test_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: url.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  process.env.DATABASE_URL = url.toString();
  const { migrate, pool } = await import('../app/server/db.server');
  const { readWork } = await import('../app/server/work.server');
  const { createWorkMcpServer } = await import('../app/mcp/server');
  const connections: { client: Client; server: ReturnType<typeof createWorkMcpServer> }[] = [];
  const identities: Person[] = [
    { id: 'admin', name: 'Synthetic Admin', email: 'admin@example.test', role: 'admin' },
    { id: 'author', name: 'Synthetic Author', email: 'author@example.test', role: 'editor' },
    { id: 'approver', name: 'Synthetic Approver', email: 'approver@example.test', role: 'editor' },
    { id: 'other', name: 'Synthetic Other', email: 'other@example.test', role: 'editor' },
    { id: 'viewer', name: 'Synthetic Viewer', email: 'viewer@example.test', role: 'viewer' },
  ];
  try {
    await migrate();
    for (const identity of identities) await pool.query('INSERT INTO people(id,name,email,team,role) VALUES($1,$2,$3,$4,$5)', [identity.id, identity.name, identity.email, '', identity.role]);
    const connect = async (id: string) => {
      const server = createWorkMcpServer(id);
      const client = new Client({ name: `adr-test-${id}`, version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      connections.push({ client, server });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return client;
    };
    const [admin, author, approver, other, viewer] = await Promise.all(identities.map(identity => connect(identity.id)));
    const call = async <S extends z.ZodType>(client: Client, name: string, args: Record<string, unknown>, output: S): Promise<z.infer<S>> => {
      const result = await client.callTool({ name, arguments: args });
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
      return output.parse(result.structuredContent);
    };
    const currentRevision = async () => (await readWork(identities[0])).revision;
    const fail = async (client: Client, name: string, args: Record<string, unknown>, code?: string) => {
      const before = await currentRevision();
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} must fail: ${JSON.stringify(result)}`);
      if (code) {
        assert.equal(result.content[0].type, 'text');
        assert.equal(JSON.parse((result.content[0] as { text: string }).text).error.code, code);
      }
      assert.equal(await currentRevision(), before, 'rejected calls cannot advance the revision');
    };
    const writeAdr = async (client: Client, name: string, args: Record<string, unknown>) => {
      const before = await currentRevision();
      const result = await call(client, name, { expectedRevision: before, ...args }, adrResult);
      assert.equal(result.revision, before + 1, 'business writes advance the shared revision exactly once');
      return result.adr;
    };
    const writeWork = async (client: Client, name: string, args: Record<string, unknown>) => call(client, name, { expectedRevision: await currentRevision(), ...args }, workMutation);
    const listNotifications = (client: Client, args: Record<string, unknown> = {}) => call(client, 'list_notifications', args, notificationsPage);
    const history = (id: string, args: Record<string, unknown> = {}) => call(author, 'list_adr_history', { adrId: id, ...args }, historyPage);
    const editable = (adr: Adr) => adrUpdateInputSchema.parse({ ...content, context: adr.context, requester: adr.requester, approver: adr.approver, mentionedPersonIds: adr.mentionedPersonIds, documentUrl: adr.documentUrl });
    let itemId = '';
    let first: Adr;
    let recorded: Adr;

    await t.test('tools expose strict bounded schemas and keep existing tools', async () => {
      const { tools } = await author.listTools();
      const names = ['list_adrs', 'get_adr', 'list_adr_history', 'create_adr', 'update_adr', 'submit_adr', 'approve_adr', 'request_adr_changes', 'record_adr_approval', 'list_notifications', 'set_notification_read'];
      const byName = new Map(tools.map(tool => [tool.name, tool]));
      const documentation = readFileSync(new URL('../docs/mcp.md', import.meta.url), 'utf8');
      for (const name of names) {
        const tool = byName.get(name);
        assert.ok(tool, name);
        assert.ok(documentation.includes(`\`${name}\``), `${name} is documented`);
        assert.equal(tool.inputSchema.additionalProperties, false, `${name} strict input`);
        assert.equal(tool.outputSchema?.additionalProperties, false, `${name} strict output`);
        assert.ok(tool.annotations);
        assert.equal(tool.inputSchema.properties?.actorId, undefined, 'no actor override');
        await fail(author, name, { actorId: 'admin' });
      }
      for (const name of ['identity', 'list_work', 'get_work', 'create_work', 'add_work_update', 'edit_work_update', 'set_work_star']) assert.ok(byName.has(name), name);
      for (const name of ['list_adrs', 'list_adr_history', 'list_notifications']) {
        const properties = byName.get(name)!.inputSchema.properties as Record<string, { maximum?: number }>;
        assert.equal(properties.limit.maximum, 100);
        const output = byName.get(name)!.outputSchema!.properties as Record<string, { maxItems?: number }>;
        assert.equal(output.items.maxItems, 100);
      }
      const stream = await writeWork(author, 'create_workstream', { workstream: { title: 'ADR test stream', description: '', leadId: 'author', goalIds: [] } });
      const item = await writeWork(author, 'create_work', { item: { ...emptyItem(stream.id), title: 'Queue work' } });
      itemId = item.id;
      const identity = await call(author, 'identity', {}, z.object({ revision, person: z.object({ id: z.string() }) }));
      assert.equal(identity.person.id, 'author');
    });

    await t.test('create, read, search, identities, filters and bounded pages', async () => {
      const input: AdrCreateInput = { ...content, itemId, approver: person('approver'), mentionedPersonIds: ['viewer'] };
      first = await writeAdr(author, 'create_adr', { adr: input });
      assert.equal(first.status, 'draft');
      assert.equal(first.creatorId, 'author');
      assert.deepEqual(first.requester, person('author'));
      assert.equal(first.approval, null);
      const read = await call(viewer, 'get_adr', { id: first.id }, adrResult);
      assert.deepEqual(read.adr, first);
      assert.equal(read.revision, await currentRevision());
      recorded = await writeAdr(author, 'create_adr', { adr: { ...content, context: 'External design', documentUrl: 'https://example.test/ADR%25reference', itemId, requester: { kind: 'name', name: 'External Requester' }, approver: { kind: 'name', name: 'External Reviewer' } } });
      for (const [filters, expected] of [
        [{ search: 'SYNCHRONOUS' }, [first.id]], [{ itemId, personId: 'author', role: 'requester' }, [first.id]],
        [{ personId: 'approver', role: 'approver' }, [first.id]], [{ name: 'External Reviewer', role: 'approver' }, [recorded.id]],
        [{ name: 'SYNTHETIC APPROVER', role: 'approver' }, [first.id]], [{ name: 'synthetic author', role: 'requester' }, [first.id]],
        [{ search: 'EXAMPLE.TEST/adr' }, [recorded.id]], [{ search: '%' }, [recorded.id]], [{ search: '_' }, []],
        [{ status: 'approved' }, []], [{ search: 'absent' }, []],
      ] as const) {
        assert.deepEqual((await call(viewer, 'list_adrs', filters, adrPage)).items.map(adr => adr.id), expected);
      }
      const page1 = await call(author, 'list_adrs', { limit: 1 }, adrPage);
      assert.equal(page1.items.length, 1);
      assert.equal(page1.nextCursor, '1');
      const page2 = await call(author, 'list_adrs', { limit: 1, cursor: page1.nextCursor }, adrPage);
      assert.equal(page2.items.length, 1);
      assert.equal(page2.nextCursor, null);
      assert.notEqual(page2.items[0].id, page1.items[0].id);
      assert.deepEqual((await call(author, 'list_adrs', { cursor: '100' }, adrPage)).items, []);
      assert.deepEqual((await call(author, 'list_adrs', { cursor: '1000001' }, adrPage)).items, []);
      const initial = await history(first.id);
      assert.equal(initial.items.length, 1);
      assert.equal(initial.items[0].actorId, 'author');
      assert.deepEqual(initial.items[0].snapshot, first);
    });

    await t.test('viewer writes, viewer nominations, missing references and malformed inputs fail without writes', async () => {
      const args = { expectedRevision: await currentRevision(), adr: { ...content, itemId, approver: person('approver') } };
      await fail(viewer, 'create_adr', args, 'forbidden');
      await fail(viewer, 'update_adr', { expectedRevision: args.expectedRevision, id: first.id, adr: editable(first) }, 'forbidden');
      await fail(viewer, 'submit_adr', { expectedRevision: args.expectedRevision, id: first.id }, 'forbidden');
      await fail(author, 'create_adr', { ...args, adr: { ...args.adr, approver: person('viewer') } }, 'invalid_reference');
      await fail(author, 'create_adr', { ...args, adr: { ...args.adr, approver: person('absent') } }, 'invalid_reference');
      await fail(author, 'create_adr', { ...args, adr: { ...args.adr, itemId: 'absent' } }, 'invalid_reference');
      await fail(author, 'create_adr', { ...args, adr: { ...args.adr, mentionedPersonIds: ['absent'] } }, 'invalid_reference');
      for (const invalid of [{ ...args, actorId: 'admin' }, { ...args, expectedRevision: -1 }, { ...args, adr: { ...args.adr, approval: {} } }, { ...args, adr: { ...args.adr, context: '' } }]) await fail(author, 'create_adr', invalid);
      for (const invalid of [{ limit: 101 }, { offset: -1 }, { recipientId: 'admin' }]) await fail(author, 'list_notifications', invalid);
      await fail(author, 'list_adrs', { search: 'x'.repeat(501) });
      await fail(author, 'get_adr', { id: 'absent' }, 'not_found');
      await fail(author, 'approve_adr', { expectedRevision: await currentRevision(), id: first.id, actorId: 'approver' });
      await fail(author, 'request_adr_changes', { expectedRevision: await currentRevision(), id: first.id, comment: '' });
    });

    await t.test('pending approval enforces nominated actor, request changes, resubmission and reapproval', async () => {
      await fail(approver, 'approve_adr', { expectedRevision: await currentRevision(), id: first.id }, 'invalid_transition');
      first = await writeAdr(author, 'submit_adr', { id: first.id });
      assert.equal(first.status, 'pending');
      assert.ok((await listNotifications(approver)).items.some(value => value.kind === 'approval_requested' && value.adrId === first.id));
      for (const client of [admin, author, other, viewer]) await fail(client, 'approve_adr', { expectedRevision: await currentRevision(), id: first.id }, 'forbidden');
      await fail(admin, 'request_adr_changes', { expectedRevision: await currentRevision(), id: first.id, comment: 'Impersonated review' }, 'forbidden');
      await fail(viewer, 'request_adr_changes', { expectedRevision: await currentRevision(), id: first.id, comment: 'Viewer review' }, 'forbidden');
      await fail(admin, 'record_adr_approval', { expectedRevision: await currentRevision(), id: first.id, comment: 'Impersonated account approval' });
      first = await writeAdr(approver, 'request_adr_changes', { id: first.id, comment: 'Document retry limits' });
      assert.equal(first.status, 'changes_requested');
      const oldHistory = (await history(first.id)).items;
      first = await writeAdr(author, 'update_adr', { id: first.id, adr: { ...editable(first), context: 'Synchronous ingestion with retries' } });
      assert.equal(first.status, 'draft');
      first = await writeAdr(author, 'submit_adr', { id: first.id });
      first = await writeAdr(approver, 'approve_adr', { id: first.id });
      assert.equal(first.status, 'approved');
      assert.equal(first.approval?.mode, 'verified');
      assert.equal(first.approval?.actorId, 'approver');
      assert.deepEqual(first.approval?.approver, person('approver'));
      first = await writeAdr(author, 'update_adr', { id: first.id, adr: { ...editable(first), context: 'New material decision revision' } });
      assert.equal(first.status, 'draft');
      assert.equal(first.approval, null, 'material changes invalidate approval');
      await fail(approver, 'approve_adr', { expectedRevision: await currentRevision(), id: first.id }, 'invalid_transition');
      first = await writeAdr(author, 'submit_adr', { id: first.id });
      first = await writeAdr(approver, 'approve_adr', { id: first.id });
      const allHistory = (await history(first.id)).items;
      for (const entry of oldHistory) assert.deepEqual(allHistory.find(current => current.id === entry.id), entry, 'old snapshots are immutable');
      const verified = allHistory.filter(entry => entry.snapshot.approval?.mode === 'verified');
      assert.equal(verified.length, 2);
      assert.ok(verified.every(entry => entry.actorId === 'approver'));
      const firstPage = await history(first.id, { limit: 2 });
      assert.equal(firstPage.items.length, 2);
      assert.equal(firstPage.nextCursor, '2');
      const secondPage = await history(first.id, { limit: 2, cursor: '2' });
      assert.equal(secondPage.items.length, 2);
      assert.ok(secondPage.items.every(entry => !firstPage.items.some(previous => previous.id === entry.id)));
      const changes = (await readWork(identities[0])).changes;
      assert.ok(changes.some(change => change.entityId === first.id), 'ADR writes publish shared business audit');
    });

    await t.test('no-op and mention-only edits retain approval and suppress self notifications', async () => {
      const approval = first.approval;
      first = await writeAdr(author, 'update_adr', { id: first.id, adr: editable(first) });
      assert.equal(first.status, 'approved');
      assert.deepEqual(first.approval, approval);
      const before = (await listNotifications(author)).items;
      first = await writeAdr(author, 'update_adr', { id: first.id, adr: { ...editable(first), mentionedPersonIds: ['viewer', 'author'] } });
      assert.equal(first.status, 'approved');
      assert.deepEqual(first.approval, approval);
      assert.deepEqual((await listNotifications(author)).items, before);
      const oldMention = (await listNotifications(viewer)).items.find(value => value.adrId === first.id && value.kind === 'mention')!;
      first = await writeAdr(author, 'update_adr', { id: first.id, adr: { ...editable(first), mentionedPersonIds: ['author'] } });
      assert.equal(first.status, 'approved');
      assert.deepEqual(first.approval, approval);
      assert.ok(!(await listNotifications(viewer)).items.some(value => value.adrId === first.id));
      await fail(viewer, 'set_notification_read', { id: oldMention.id, read: true }, 'not_found');
      first = await writeAdr(author, 'update_adr', { id: first.id, adr: { ...editable(first), mentionedPersonIds: ['viewer', 'author'] } });
      const newMentions = (await listNotifications(viewer)).items.filter(value => value.adrId === first.id && value.kind === 'mention');
      assert.equal(newMentions.length, 1);
      assert.notEqual(newMentions[0].id, oldMention.id);
      assert.deepEqual(first.approval, approval);
      await fail(approver, 'approve_adr', { expectedRevision: await currentRevision(), id: first.id }, 'invalid_transition');
    });

    await t.test('external approval is explicitly recorded and never authenticated as a plain name', async () => {
      recorded = await writeAdr(author, 'submit_adr', { id: recorded.id });
      await fail(admin, 'approve_adr', { expectedRevision: await currentRevision(), id: recorded.id }, 'forbidden');
      await fail(viewer, 'record_adr_approval', { expectedRevision: await currentRevision(), id: recorded.id, comment: 'External meeting' }, 'forbidden');
      recorded = await writeAdr(author, 'record_adr_approval', { id: recorded.id });
      assert.equal(recorded.status, 'approved');
      assert.equal(recorded.approval?.mode, 'recorded');
      assert.equal(recorded.approval?.actorId, 'author');
      assert.deepEqual(recorded.approval?.approver, { kind: 'name', name: 'External Reviewer' });
      assert.equal((await history(recorded.id)).items.find(entry => entry.snapshot.approval)?.actorId, 'author');
    });

    await t.test('stale business revisions roll back ADR, history, audit and notifications', async () => {
      const before = await call(author, 'get_adr', { id: first.id }, adrResult);
      const beforeHistory = await history(first.id);
      const beforeNotifications = await Promise.all([author, approver, viewer].map(client => listNotifications(client)));
      const beforeChanges = (await readWork(identities[0])).changes;
      await fail(author, 'update_adr', { expectedRevision: before.revision - 1, id: first.id, adr: { ...editable(first), context: 'Stale content', mentionedPersonIds: ['other'] } }, 'revision_conflict');
      await fail(author, 'create_adr', { expectedRevision: before.revision - 1, adr: { ...content, itemId, approver: person('approver'), mentionedPersonIds: ['other'] } }, 'revision_conflict');
      assert.deepEqual(await call(author, 'get_adr', { id: first.id }, adrResult), before);
      assert.deepEqual(await history(first.id), beforeHistory);
      assert.deepEqual(await Promise.all([author, approver, viewer].map(client => listNotifications(client))), beforeNotifications);
      assert.deepEqual((await readWork(identities[0])).changes, beforeChanges);
    });

    await t.test('notifications are private including admins and read state is idempotent without shared audit', async () => {
      const viewerNotifications = await listNotifications(viewer);
      assert.ok(viewerNotifications.items.some(value => value.kind === 'mention' && value.adrId === first.id));
      assert.deepEqual((await listNotifications(approver)).items, [], 'completed approval requests are no longer actionable');
      assert.ok((await listNotifications(author)).items.some(value => value.kind === 'approval_result'));
      assert.deepEqual((await listNotifications(admin)).items, []);
      assert.deepEqual((await listNotifications(other)).items, []);
      for (const [client, id] of [[viewer, 'viewer'], [approver, 'approver'], [author, 'author']] as const) {
        assert.ok((await listNotifications(client)).items.every(value => value.recipientId === id));
      }
      const notification = viewerNotifications.items[0];
      const before = await readWork(identities[0]);
      await fail(admin, 'set_notification_read', { id: notification.id, read: true }, 'not_found');
      const output = z.object({ notification: workNotificationSchema }).strict();
      const read = await call(viewer, 'set_notification_read', { id: notification.id, read: true }, output);
      assert.ok(read.notification.readAt);
      assert.deepEqual(await call(viewer, 'set_notification_read', { id: notification.id, read: true }, output), read);
      assert.ok(!(await listNotifications(viewer, { unreadOnly: true })).items.some(value => value.id === notification.id));
      assert.equal((await call(viewer, 'set_notification_read', { id: notification.id, read: false }, output)).notification.readAt, null);
      assert.equal((await readWork(identities[0])).revision, before.revision);
      assert.deepEqual((await readWork(identities[0])).changes, before.changes);
      const page = await listNotifications(author, { limit: 1 });
      assert.equal(page.items.length, 1);
      assert.equal(page.nextCursor, '1');
      assert.notEqual((await listNotifications(author, { limit: 1, cursor: '1' })).items[0].id, page.items[0].id);
    });

    await t.test('existing work tools preserve mention compatibility and notify only new recipients', async () => {
      const beforeViewer = (await listNotifications(viewer)).items.length;
      const beforeOther = (await listNotifications(other)).items.length;
      const note = await writeWork(author, 'add_work_update', { itemId, kind: 'note', body: 'Synthetic note', mentionedPersonIds: ['viewer'] });
      assert.equal((await listNotifications(viewer)).items.length, beforeViewer + 1);
      const firstNotice = (await listNotifications(viewer)).items.find(value => value.updateId === note.id)!;
      const protectedState = await readWork(identities[0]);
      await fail(viewer, 'add_work_update', { expectedRevision: await currentRevision(), itemId, kind: 'note', body: 'Viewer mention', mentionedPersonIds: ['other'] }, 'forbidden');
      await fail(other, 'edit_work_update', { expectedRevision: await currentRevision(), id: note.id, body: 'Unauthorized edit', mentionedPersonIds: ['other'] }, 'forbidden');
      assert.deepEqual(await readWork(identities[0]), protectedState);
      await writeWork(author, 'edit_work_update', { id: note.id, body: 'Old client text edit' });
      let update = (await readWork(identities[0])).updates.find(value => value.id === note.id)!;
      assert.deepEqual(update.mentionedPersonIds, ['viewer']);
      assert.equal((await listNotifications(viewer)).items.length, beforeViewer + 1);
      await writeWork(author, 'edit_work_update', { id: note.id, body: 'Add mention', mentionedPersonIds: ['viewer', 'other'] });
      assert.equal((await listNotifications(other)).items.length, beforeOther + 1);
      assert.equal((await listNotifications(viewer)).items.length, beforeViewer + 1);
      await writeWork(author, 'edit_work_update', { id: note.id, body: 'Remove mentions', mentionedPersonIds: [] });
      update = (await readWork(identities[0])).updates.find(value => value.id === note.id)!;
      assert.deepEqual(update.mentionedPersonIds, []);
      for (const client of [viewer, other]) assert.ok(!(await listNotifications(client)).items.some(value => value.updateId === note.id));
      await fail(viewer, 'set_notification_read', { id: firstNotice.id, read: true }, 'not_found');
      await writeWork(author, 'edit_work_update', { id: note.id, body: 'Re-add viewer mention', mentionedPersonIds: ['viewer'] });
      const readded = (await listNotifications(viewer)).items.filter(value => value.updateId === note.id);
      assert.equal(readded.length, 1);
      assert.notEqual(readded[0].id, firstNotice.id);
      await writeWork(author, 'delete_work_update', { id: note.id });
      assert.ok(!(await listNotifications(viewer)).items.some(value => value.updateId === note.id));
      assert.equal((await pool.query('SELECT id FROM simple_notifications WHERE update_id=$1', [note.id])).rowCount, 0);
      const original = await writeWork(author, 'add_work_update', { itemId, kind: 'note', body: 'Legacy no mentions' });
      assert.deepEqual((await readWork(identities[0])).updates.find(value => value.id === original.id)?.mentionedPersonIds, []);
      await fail(author, 'add_work_update', { expectedRevision: await currentRevision(), itemId, kind: 'note', body: 'Bad mentions', mentionedPersonIds: ['viewer', 'viewer'] });
      const beforeInvalid = await readWork(identities[0]);
      const beforeInvalidNotifications = await Promise.all([viewer, other].map(client => listNotifications(client)));
      await fail(author, 'add_work_update', { expectedRevision: await currentRevision(), itemId, kind: 'note', body: 'Unknown mention must roll back', mentionedPersonIds: ['viewer', 'absent'] }, 'invalid_reference');
      await fail(author, 'edit_work_update', { expectedRevision: await currentRevision(), id: original.id, body: 'Unknown edit mention must roll back', mentionedPersonIds: ['viewer', 'absent'] }, 'invalid_reference');
      assert.deepEqual(await readWork(identities[0]), beforeInvalid, 'failed mention writes preserve notes, audit and revision');
      assert.deepEqual(await Promise.all([viewer, other].map(client => listNotifications(client))), beforeInvalidNotifications);
      const before = await currentRevision();
      await call(viewer, 'set_work_star', { itemId, starred: true }, workMutation);
      assert.equal(await currentRevision(), before);
      await call(viewer, 'get_work', { itemId }, z.object({ starred: z.literal(true) }));
    });

    await t.test('live role changes revoke permissions and ADR dependencies block deletion', async () => {
      let draft = await writeAdr(author, 'create_adr', { adr: { ...content, itemId, approver: person('other') } });
      draft = await writeAdr(author, 'submit_adr', { id: draft.id });
      await writeWork(admin, 'update_person', { id: 'other', person: { name: 'Synthetic Other', email: 'other@example.test', role: 'viewer' } });
      await fail(other, 'approve_adr', { expectedRevision: await currentRevision(), id: draft.id }, 'forbidden');
      await fail(other, 'create_adr', { expectedRevision: await currentRevision(), adr: { ...content, itemId, approver: person('approver') } }, 'forbidden');
      await fail(admin, 'delete_person', { expectedRevision: await currentRevision(), id: 'approver' }, 'entity_in_use');
      await fail(admin, 'delete_person', { expectedRevision: await currentRevision(), id: 'author' }, 'entity_in_use');
      // A separate item with only an ADR proves the blocker is ADR linkage,
      // rather than the updates added by the compatibility test above.
      const streamId = (await readWork(identities[0])).workstreams[0].id;
      const linked = await writeWork(author, 'create_work', { item: { ...emptyItem(streamId), title: 'ADR-only dependency' } });
      await writeAdr(author, 'create_adr', { adr: { ...content, itemId: linked.id, approver: person('approver') } });
      await fail(admin, 'delete_work', { expectedRevision: await currentRevision(), id: linked.id }, 'entity_in_use');
      assert.ok((await readWork(identities[0])).items.some(item => item.id === linked.id));
    });
    await t.test('actual stdio launcher advertises schemas and completes authenticated approval', async () => {
      const clients: Client[] = [];
      const stdio = async (id: string) => {
        const client = new Client({ name: `adr-stdio-${id}`, version: '1.0.0' });
        clients.push(client);
        await client.connect(new StdioClientTransport({
          command: process.execPath,
          args: ['--import', 'tsx', 'scripts/mcp.ts'],
          cwd: process.cwd(),
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'test', DATABASE_URL: url.toString(), GOALIE_MCP_PERSON_ID: id, AI_ENABLED: 'false', OPENJEV_ENABLED: 'false' },
          stderr: 'pipe',
        }));
        return client;
      };
      try {
        const writer = await stdio('author');
        const reviewer = await stdio('approver');
        const tools = await writer.listTools();
        assert.ok(tools.tools.some(tool => tool.name === 'create_adr' && tool.inputSchema.additionalProperties === false));
        let adr = await writeAdr(writer, 'create_adr', { adr: { ...content, itemId, approver: person('approver') } });
        adr = await writeAdr(writer, 'submit_adr', { id: adr.id });
        await fail(writer, 'approve_adr', { id: adr.id, expectedRevision: await currentRevision() }, 'forbidden');
        adr = await writeAdr(reviewer, 'approve_adr', { id: adr.id });
        assert.equal(adr.approval?.actorId, 'approver');
        assert.equal(adr.approval?.mode, 'verified');
        assert.equal((await call(writer, 'get_adr', { id: adr.id }, adrResult)).adr.status, 'approved');
        const timeline = await call(writer, 'list_adr_history', { adrId: adr.id }, historyPage);
        assert.equal(timeline.items.length, 3);
        assert.equal(timeline.items[0].actorId, 'approver');
      } finally {
        for (const client of clients) await client.close();
      }
    });
  } finally {
    for (const { client, server } of connections) {
      await client.close();
      await server.close();
    }
    await pool.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
  }
});
