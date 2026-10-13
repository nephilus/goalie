import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  adrIdentitySchema, adrContentSchema, adrCreateInputSchema, adrUpdateInputSchema,
  adrCommandRequestSchema, adrListQuerySchema, adrHistoryQuerySchema, notificationListQuerySchema,
} from '../app/shared/adr';

const content = {
  context: 'Existing synchronous requests', concern: 'Latency during demand spikes',
  decision: 'Use a bounded queue', alternatives: 'Increase synchronous workers',
  consequences: 'Eventual completion', downsides: 'Extra operational state', rationale: 'Bound resource use',
};
const approver = { kind: 'person' as const, personId: 'approver' };

test('documented MCP create example parses through the production command schema', () => {
  const documentation = readFileSync(new URL('../docs/mcp.md', import.meta.url), 'utf8');
  const examples = [...documentation.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]));
  const example = examples.find(value => 'expectedRevision' in value && 'adr' in value);
  assert.ok(example, 'public reference contains a complete create_adr example');
  const parsed = adrCommandRequestSchema.parse({ expectedRevision: example.expectedRevision, command: { type: 'adr.create', adr: example.adr } });
  assert.equal(parsed.command.type, 'adr.create');
});

test('ADR schemas require seven content fields and explicit account or plain-name identities', () => {
  assert.deepEqual(adrContentSchema.parse(content), content);
  const input = adrCreateInputSchema.parse({ ...content, itemId: 'work', approver });
  assert.equal(input.requester, undefined, 'requester omission is resolved to actor by service');
  assert.deepEqual(input.mentionedPersonIds, []);
  assert.deepEqual(adrIdentitySchema.parse({ kind: 'name', name: ' External reviewer ' }), { kind: 'name', name: 'External reviewer' });
  for (const field of Object.keys(content)) {
    assert.equal(adrContentSchema.safeParse({ ...content, [field]: undefined }).success, false, field);
    assert.equal(adrContentSchema.safeParse({ ...content, [field]: ' ' }).success, false, field);
    assert.equal(adrContentSchema.safeParse({ ...content, [field]: 'x'.repeat(20001) }).success, false, field);
  }
  for (const identity of [
    { kind: 'person', personId: '' }, { kind: 'person', personId: 'a', name: 'Impersonation' },
    { kind: 'name', name: ' ' }, { kind: 'name', name: 'External', personId: 'a' },
    { name: 'Ambiguous' }, { kind: 'admin', personId: 'admin' },
  ]) assert.equal(adrIdentitySchema.safeParse(identity).success, false);
  assert.equal(adrCreateInputSchema.safeParse({ ...content, itemId: 'work' }).success, false);
  assert.equal(adrUpdateInputSchema.safeParse({ ...content, approver }).success, false);
  assert.equal(adrCreateInputSchema.safeParse({ ...content, itemId: 'work', approver, status: 'approved' }).success, false);
});

test('ADR schemas reject unsafe URLs, forged attribution, malformed commands and unbounded mentions', () => {
  const valid = { ...content, itemId: 'work', approver };
  for (const documentUrl of ['javascript:alert(1)', 'file:///private', 'ftp://example.test/adr', 'not a URL']) {
    assert.equal(adrCreateInputSchema.safeParse({ ...valid, documentUrl }).success, false);
  }
  assert.equal(adrCreateInputSchema.safeParse({ ...valid, documentUrl: 'https://example.test/adr' }).success, true);
  assert.equal(adrCreateInputSchema.safeParse({ ...valid, documentUrl: null }).success, true);
  for (const mentionedPersonIds of [['same', 'same'], [''], Array.from({ length: 101 }, (_, i) => `p${i}`)]) {
    assert.equal(adrCreateInputSchema.safeParse({ ...valid, mentionedPersonIds }).success, false);
  }
  for (const forged of [{ actorId: 'admin' }, { creatorId: 'admin' }, { approval: { mode: 'verified' } }, { revision: 5 }]) {
    assert.equal(adrCreateInputSchema.safeParse({ ...valid, ...forged }).success, false);
  }
  const submit = { expectedRevision: 0, command: { type: 'adr.submit', id: 'adr' } };
  assert.equal(adrCommandRequestSchema.safeParse(submit).success, true);
  for (const expectedRevision of [-1, 1.5, '1', undefined]) assert.equal(adrCommandRequestSchema.safeParse({ ...submit, expectedRevision }).success, false);
  assert.equal(adrCommandRequestSchema.safeParse({ expectedRevision: 0, command: { type: 'adr.record_approval', id: 'adr' } }).success, true);
  for (const type of ['adr.request_changes']) {
    for (const comment of ['', ' ', 'x'.repeat(10001), undefined]) {
      assert.equal(adrCommandRequestSchema.safeParse({ expectedRevision: 0, command: { type, id: 'adr', comment } }).success, false);
    }
  }
  assert.equal(adrCommandRequestSchema.safeParse({ expectedRevision: 0, command: { type: 'adr.approve', id: 'adr', actorId: 'approver' } }).success, false);
});

test('ADR and notification list schemas have strict bounded pagination and no recipient impersonation', () => {
  for (const schema of [adrListQuerySchema, notificationListQuerySchema]) {
    assert.equal(schema.parse({}).limit, 25);
    assert.equal(schema.parse({}).cursor, undefined);
    assert.equal(schema.safeParse({ cursor: '1000001' }).success, true);
    assert.equal(schema.safeParse({ cursor: '9007199254740991' }).success, true);
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '-1' }, { cursor: '9007199254740992' }, { cursor: '0'.repeat(17) }, { cursor: 1 }, { cursor: 'not-a-cursor' }, { offset: 1 }, { extra: true }]) {
      assert.equal(schema.safeParse(input).success, false);
    }
  }
  assert.equal(adrHistoryQuerySchema.safeParse({ adrId: 'adr', limit: 100 }).success, true);
  assert.equal(adrHistoryQuerySchema.safeParse({ limit: 1 }).success, false);
  assert.equal(adrListQuerySchema.safeParse({ search: 'x'.repeat(501) }).success, false);
  assert.equal(adrListQuerySchema.safeParse({ status: 'rejected' }).success, false);
  assert.equal(adrListQuerySchema.safeParse({ role: 'admin' }).success, false);
  assert.equal(notificationListQuerySchema.safeParse({ recipientId: 'another-person' }).success, false);
});
