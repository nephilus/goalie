import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { adrUpdateInputSchema, type Adr, type AdrCommandRequest, type AdrMutationResult, type AdrPage, type AdrHistoryEntry, type WorkNotification } from '../app/shared/adr';

// Real session cookies, CSRF checks, route handlers and services, in a disposable schema.
// Never fall back to DATABASE_URL: the operator must explicitly supply a test database.
test('ADR HTTP routes enforce authenticated commands, strict transport and private inboxes', { skip: !process.env.WORK_TEST_DATABASE_URL }, async t => {
  const originalEnv = { ...process.env };
  const url = new URL(process.env.WORK_TEST_DATABASE_URL!);
  const schema = `adr_http_${randomUUID().replaceAll('-', '')}`;
  const control = new Pool({ connectionString: url.toString() });
  await control.query(`CREATE SCHEMA ${schema}`);
  url.searchParams.set('options', `-c search_path=${schema}`);
  Object.assign(process.env, { DATABASE_URL: url.toString(), NODE_ENV: 'test', APP_URL: 'http://127.0.0.1:4399', OIDC_ISSUER: 'http://127.0.0.1:5558/dex', OIDC_CLIENT_ID: 'http-fixture', OIDC_CLIENT_SECRET: 'synthetic-secret', MAX_REQUEST_BODY_BYTES: '4096', AI_ENABLED: 'false', OPENJEV_ENABLED: 'false' });
  delete process.env.DB_CA_FILE;
  const { migrate, pool } = await import('../app/server/db.server');
  const { authCookieHeaders } = await import('../app/server/auth.server');
  const { loader, action } = await import('../app/routes/work-api');
  const origin = process.env.APP_URL!;
  const sessions = new Map<string, { cookie: string; csrf: string }>();
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const fields = { context: 'HTTP context', concern: 'Concern', decision: 'Use shared services', alternatives: 'Duplicate logic', consequences: 'Consistency', downsides: 'Coupling', rationale: 'Auditability' };
  const revision = async () => Number((await pool.query('SELECT revision FROM simple_workspace WHERE id=1')).rows[0].revision);
  async function request(path: string, actor: string | null = 'editor', input?: unknown, overrides: RequestInit = {}) {
    const session = actor ? sessions.get(actor) : undefined;
    const method = overrides.method ?? (input === undefined ? 'GET' : 'POST');
    const headers = new Headers({ ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}), origin, 'content-type': 'application/json' });
    new Headers(overrides.headers).forEach((value, key) => headers.set(key, value));
    const req = new Request(`${origin}${path}`, { ...overrides, method, headers, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    const response = await (method === 'GET' ? loader : action)({ request: req });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    return response;
  }
  async function data<T>(response: Response, actor = 'editor'): Promise<T> {
    assert.equal(response.status, 200, await response.clone().text());
    const envelope = await response.json();
    assert.equal(envelope.user.id, actor);
    assert.equal(envelope.csrfToken, sessions.get(actor)!.csrf);
    return envelope.data as T;
  }
  async function error(response: Response, status: number, code: string) {
    assert.equal(response.status, status, await response.clone().text());
    assert.equal((await response.json()).code, code);
  }
  const mutate = async (command: AdrCommandRequest['command'], actor = 'editor') => data<AdrMutationResult>(await request('/api/work/adrs', actor, { expectedRevision: await revision(), command }), actor);
  const create = { type: 'adr.create' as const, adr: { ...fields, itemId: 'child', approver: { kind: 'person' as const, personId: 'approver' }, mentionedPersonIds: ['viewer'] } };
  let adr: Adr;
  try {
    await migrate();
    for (const [id, role] of [['admin', 'admin'], ['editor', 'editor'], ['approver', 'editor'], ['viewer', 'viewer']]) {
      await pool.query('INSERT INTO people(id,name,email,team,role) VALUES($1,$1,$2,\'\',$3)', [id, `${id}@example.test`, role]);
      const session = randomUUID(), csrf = randomUUID();
      await pool.query("INSERT INTO sessions(id_hash,person_id,csrf_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')", [hash(session), id, hash(csrf)]);
      sessions.set(id, { csrf, cookie: authCookieHeaders(new Request(origin), session, csrf).map(value => value.split(';')[0]).join('; ') });
    }
    await pool.query("INSERT INTO simple_workstreams(id,title,description,lead_id) VALUES('stream','Synthetic HTTP stream','','editor')");
    await pool.query("INSERT INTO simple_items(id,title,description,workstream_id,status,blocker) VALUES('parent','Parent','','stream','todo','')");
    await pool.query("INSERT INTO simple_items(id,title,description,workstream_id,parent_id,status,blocker) VALUES('child','Child','','stream','parent','todo','')");

    await t.test('authentication, CSRF and HTTP methods fail closed before mutations', async () => {
      for (const path of ['/api/work/adrs', '/api/work/adrs/missing', '/api/work/adrs/missing/history', '/api/work/notifications']) await error(await request(path, null), 401, 'unauthenticated');
      const input = { expectedRevision: await revision(), command: create };
      await error(await request('/api/work/adrs', null, input), 401, 'unauthenticated');
      const rejectedHeaders: Record<string, string>[] = [{ 'x-csrf-token': '' }, { origin: 'https://evil.example' }, { 'x-csrf-token': 'forged' }];
      for (const headers of rejectedHeaders) await error(await request('/api/work/adrs', 'editor', input, { headers }), 403, 'forbidden');
      for (const method of ['PUT', 'PATCH', 'DELETE']) await error(await request('/api/work/adrs', 'editor', input, { method }), 405, 'method_not_allowed');
      await error(await request('/api/work/adrs', 'viewer', input), 403, 'forbidden');
      assert.equal((await pool.query('SELECT count(*)::int n FROM simple_adrs')).rows[0].n, 0);
    });

    await t.test('strict query decoding rejects duplicate, unknown and malformed bounds', async () => {
      const queries = ['limit=1&limit=2', 'search=a&search=b', 'unknown=x', '__proto__=x', 'limit=', 'limit=0', 'limit=101', 'limit=01', 'limit=1e1', 'limit=1.2', 'limit=%20', 'cursor=-1', 'cursor=01', 'cursor=9007199254740992', 'status=accepted', 'role=creator', 'search=', `search=${'x'.repeat(501)}`, 'personId=', `itemId=${'x'.repeat(101)}`];
      for (const query of queries) await error(await request(`/api/work/adrs?${query}`), 422, 'invalid_request');
      for (const query of ['unreadOnly=1', 'unreadOnly=', 'unreadOnly=TRUE', 'unreadOnly=true&unreadOnly=false', 'personId=viewer', 'limit=101']) await error(await request(`/api/work/notifications?${query}`), 422, 'invalid_request');
      for (const path of ['/api/work/adrs/missing?limit=1', '/api/work/adrs/missing/history?adrId=other', '/api/work/adrs/missing/history?cursor=0&cursor=1', '/api/work/adrs/%ZZ', '/api/work/adrs/%20', `/api/work/adrs/${'x'.repeat(101)}`]) await error(await request(path), 422, 'invalid_request');
      await error(await request('/api/work/adrs/missing'), 404, 'not_found');
      await error(await request('/api/work/adrs/missing/history'), 404, 'not_found');
      await error(await request('/api/work/adrs/missing/unknown'), 404, 'not_found');
    });

    await t.test('strict commands reject forged attribution and bounded invalid bodies', async () => {
      const input = { expectedRevision: await revision(), command: create };
      for (const bad of [{ ...input, actorId: 'admin' }, { ...input, command: { ...create, actorId: 'admin' } }, { ...input, command: { ...create, adr: { ...create.adr, creatorId: 'admin' } } }, { ...input, command: { ...create, adr: { ...create.adr, documentUrl: 'javascript:alert(1)' } } }]) await error(await request('/api/work/adrs', 'editor', bad), 422, 'invalid_request');
      await error(await request('/api/work/adrs?actorId=admin', 'editor', input), 422, 'invalid_request');
      await error(await request('/api/work/adrs', 'editor', undefined, { method: 'POST', body: '{broken' }), 422, 'invalid_request');
      await error(await request('/api/work/adrs', 'editor', undefined, { method: 'POST' }), 422, 'invalid_request');
      await error(await request('/api/work/adrs', 'editor', input, { headers: { 'content-length': '4097' } }), 413, 'too_large');
      await error(await request('/api/work/adrs', 'editor', { text: 'x'.repeat(4097) }), 413, 'too_large');
      adr = (await mutate(create)).adr;
      assert.equal(adr.creatorId, 'editor');
      assert.deepEqual(adr.requester, { kind: 'person', personId: 'editor' });
      assert.equal(adr.itemId, 'child');
      const before = await revision();
      await error(await request('/api/work/adrs', 'editor', input), 409, 'revision_conflict');
      assert.equal(await revision(), before);
    });

    await t.test('list, detail, filters and pagination use shared response contracts', async () => {
      const external = await mutate({ type: 'adr.create', adr: { ...fields, itemId: 'parent', context: 'Different context', approver: { kind: 'name', name: 'External Reviewer' } } });
      const page = await data<AdrPage<Adr>>(await request('/api/work/adrs?limit=1'));
      assert.equal(page.items.length, 1);
      assert.equal(page.nextCursor, '1');
      const second = await data<AdrPage<Adr>>(await request('/api/work/adrs?limit=1&cursor=1'));
      assert.equal(second.nextCursor, null);
      assert.notEqual(page.items[0].id, second.items[0].id);
      for (const query of ['search=HTTP%20CONTEXT', 'personId=approver&role=approver', 'personId=editor&role=requester', 'itemId=child&status=draft']) {
        const filtered = await data<AdrPage<Adr>>(await request(`/api/work/adrs?${query}`));
        assert.ok(filtered.items.some(item => item.id === adr.id));
      }
      assert.equal((await data<AdrPage<Adr>>(await request('/api/work/adrs?personId=approver&role=requester'))).items.length, 0);
      assert.equal((await data<AdrPage<Adr>>(await request('/api/work/adrs?name=external&role=approver'))).items[0].id, external.adr.id);
      assert.equal((await data<AdrMutationResult>(await request(`/api/work/adrs/${adr.id}`, 'viewer'), 'viewer')).adr.id, adr.id);
    });

    await t.test('approval workflow attributes session actor and preserves paginated history', async () => {
      adr = (await mutate({ type: 'adr.submit', id: adr.id })).adr;
      await error(await request('/api/work/adrs', 'admin', { expectedRevision: await revision(), command: { type: 'adr.approve', id: adr.id } }), 403, 'forbidden');
      const inbox = await data<AdrPage<WorkNotification>>(await request('/api/work/notifications?unreadOnly=true', 'approver'), 'approver');
      assert.ok(inbox.items.some(item => item.adrId === adr.id && item.kind === 'approval_requested'));
      adr = (await mutate({ type: 'adr.request_changes', id: adr.id, comment: 'Expand rationale' }, 'approver')).adr;
      assert.equal(adr.status, 'changes_requested');
      adr = (await mutate({ type: 'adr.submit', id: adr.id })).adr;
      adr = (await mutate({ type: 'adr.approve', id: adr.id }, 'approver')).adr;
      assert.equal(adr.approval?.actorId, 'approver');
      assert.equal(adr.approval?.mode, 'verified');
      const history = await data<AdrPage<AdrHistoryEntry>>(await request(`/api/work/adrs/${adr.id}/history?limit=1`));
      assert.equal(history.items[0].actorId, 'approver');
      assert.equal(history.items[0].action, 'adr.approve');
      assert.equal(history.nextCursor, '1');
      assert.equal((await data<AdrPage<AdrHistoryEntry>>(await request(`/api/work/adrs/${adr.id}/history?limit=1&cursor=1`))).items[0].action, 'adr.submit');
      const editable = adrUpdateInputSchema.parse(Object.fromEntries(Object.entries(adr).filter(([key]) => !['id', 'itemId', 'creatorId', 'status', 'revision', 'approval', 'createdAt', 'updatedAt'].includes(key))));
      adr = (await mutate({ type: 'adr.update', id: adr.id, adr: { ...editable, decision: 'Revised decision' } })).adr;
      assert.equal(adr.status, 'draft');
      assert.equal(adr.approval, null);
      const external = await mutate({ type: 'adr.create', adr: { ...fields, itemId: 'parent', approver: { kind: 'name', name: 'Outside Board' } } });
      await mutate({ type: 'adr.submit', id: external.adr.id });
      const recorded = await mutate({ type: 'adr.record_approval', id: external.adr.id, comment: 'Meeting record' });
      assert.equal(recorded.adr.approval?.mode, 'recorded');
      assert.equal(recorded.adr.approval?.actorId, 'editor');
    });

    await t.test('recipient-only read/unread is CSRF protected and leaves shared revision unchanged', async () => {
      const inbox = await data<AdrPage<WorkNotification>>(await request('/api/work/notifications?unreadOnly=true', 'viewer'), 'viewer');
      const mention = inbox.items.find(item => item.adrId === adr.id)!;
      assert.ok(mention);
      assert.equal(mention.kind, 'mention');
      const input = { id: mention.id, read: true };
      await error(await request('/api/work/notifications/read', 'viewer', input, { headers: { 'x-csrf-token': '' } }), 403, 'forbidden');
      await error(await request('/api/work/notifications/read', 'admin', input), 404, 'not_found');
      for (const bad of [{ ...input, recipientId: 'viewer' }, { id: mention.id, read: 'true' }, { id: mention.id }, { id: '', read: true }]) await error(await request('/api/work/notifications/read', 'viewer', bad), 422, 'invalid_request');
      await error(await request('/api/work/notifications/read?read=true', 'viewer', input), 422, 'invalid_request');
      const before = await revision();
      assert.ok((await data<WorkNotification>(await request('/api/work/notifications/read', 'viewer', input), 'viewer')).readAt);
      assert.equal((await data<AdrPage<WorkNotification>>(await request('/api/work/notifications?unreadOnly=true', 'viewer'), 'viewer')).items.length, 0);
      assert.equal((await data<AdrPage<WorkNotification>>(await request('/api/work/notifications?unreadOnly=false', 'viewer'), 'viewer')).items.length, 1);
      assert.equal((await data<WorkNotification>(await request('/api/work/notifications/read', 'viewer', { ...input, read: false }), 'viewer')).readAt, null);
      assert.equal(await revision(), before);
      assert.equal((await data<AdrPage<WorkNotification>>(await request('/api/work/notifications', 'admin'), 'admin')).items.length, 0);
    });

    await t.test('revoked roles and expired sessions are read from authoritative rows', async () => {
      await pool.query("UPDATE people SET role='viewer' WHERE id='editor'");
      await error(await request('/api/work/adrs', 'editor', { expectedRevision: await revision(), command: create }), 403, 'forbidden');
      await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE person_id='editor'");
      await error(await request('/api/work/adrs', 'editor'), 401, 'unauthenticated');
    });
  } finally {
    await pool.end();
    await control.query(`DROP SCHEMA ${schema} CASCADE`);
    await control.end();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  }
});
