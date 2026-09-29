import { test } from 'node:test';
import assert from 'node:assert/strict';

Object.assign(process.env, { DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:54399/goalie', APP_URL: 'https://goalie.example.test:4310', OIDC_ISSUER: 'https://identity.example.test/dex', OIDC_CLIENT_ID: 'fixture', OIDC_CLIENT_SECRET: 'fixture' });
const { authCookieHeaders, clearAuthCookieHeaders, getAuth } = await import('../app/server/auth.server');
const { pool } = await import('../app/server/db.server');
const pair = (header: string) => header.split(';', 1)[0].split('=');

test('two deployments on one hostname keep independent sessions and logout', async () => {
  try {
    const demo = new Request('https://goalie.example.test:4310/');
    const blank = new Request('https://goalie.example.test:4311/');
    const demoHeaders = authCookieHeaders(demo, 'demo-session', 'demo-csrf');
    process.env.APP_URL = new URL(blank.url).origin;
    const blankHeaders = authCookieHeaders(blank, 'blank-session', 'blank-csrf');
    const jar = new Map([...demoHeaders, ...blankHeaders].map(header => pair(header) as [string, string]));
    assert.equal(jar.size, 4, 'signing into blank must not replace demo cookies');
    for (const header of clearAuthCookieHeaders(blank)) jar.delete(pair(header)[0]);
    assert.deepEqual([...jar.values()].sort(), ['demo-csrf', 'demo-session']);
    assert.equal(await getAuth(new Request(blank.url, { headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } })), null, 'demo cookies cannot authenticate against blank');
    for (const header of [...demoHeaders, ...blankHeaders]) {
      assert.match(header, /; Secure(?:;|$)/);
      assert.match(header, /; SameSite=Lax(?:;|$)/);
      assert.doesNotMatch(header, /; Domain=/i);
    }
    assert.match(demoHeaders[0], /; HttpOnly(?:;|$)/);
    assert.match(blankHeaders[0], /; HttpOnly(?:;|$)/);
  } finally { await pool.end(); }
});
