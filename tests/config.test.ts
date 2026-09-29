import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, sameOrigin } from '../app/server/config.server';
import { dateSchema } from '../app/shared/model';

const production = { NODE_ENV: 'production', DATABASE_URL: 'postgresql://db/goalie', APP_URL: 'https://goalie.example.test', OIDC_ISSUER: 'https://gitlab.example.test', OIDC_CLIENT_ID: 'goalie', OIDC_CLIENT_SECRET: 'fixture-secret' };

test('unsafe requests need the configured Origin, not merely a same-origin target URL', () => {
  const config = getConfig(production);
  assert.equal(sameOrigin(new Request('https://goalie.example.test/api/commands', { headers: { origin: 'https://attacker.example.test' } }), config), false);
  assert.equal(sameOrigin(new Request('https://goalie.example.test/api/commands'), config), false);
  assert.equal(sameOrigin(new Request('http://127.0.0.1:4310/api/commands', { headers: { origin: production.APP_URL } }), config), true);
});

test('production rejects insecure issuers and credential-bearing or subpath origins', () => {
  assert.throws(() => getConfig({ ...production, OIDC_ISSUER: 'http://gitlab.example.test' }), /HTTPS/);
  assert.throws(() => getConfig({ ...production, APP_URL: 'https://user:secret@goalie.example.test' }), /credentials/);
  assert.throws(() => getConfig({ ...production, APP_URL: 'https://goalie.example.test/goalie' }), /subpath/);
  assert.throws(() => getConfig({ ...production, NODE_ENV: 'development', OIDC_ISSUER: 'http://127.0.0.1:5558/dex-other' }), /loopback Dex/);
});

test('calendar dates reject normalization into a different month', () => {
  assert.equal(dateSchema.safeParse('2026-02-29').success, false);
  assert.equal(dateSchema.safeParse('2024-02-29').success, true);
});

test('isolated development issuers allow explicit loopback ports without allowing remote HTTP', () => {
  const development = { ...production, NODE_ENV: 'development', OIDC_ISSUER: 'http://127.0.0.1:5559/dex' };
  assert.equal(getConfig(development).oidcIssuer.port, '5559');
  assert.throws(() => getConfig({ ...development, OIDC_ISSUER: 'http://identity.example.test:5559/dex' }), /loopback Dex/);
  assert.throws(() => getConfig({ ...development, OIDC_ISSUER: 'http://127.0.0.1/dex' }), /explicit port/);
  assert.throws(() => getConfig({ ...development, NODE_ENV: 'production' }), /HTTPS/);
});
