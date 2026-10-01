import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helm = process.env.HELM || 'helm';
const chart = process.argv[2] || 'charts/goalie';
assert(process.argv.length <= 3, 'Usage: node scripts/check-chart.mjs [chart]');
const directory = mkdtempSync(join(tmpdir(), 'goalie-chart-'));
const base = {
  image: { repository: 'registry.example.test/goalie', digest: `sha256:${'a'.repeat(64)}` },
  app: { url: 'https://goalie.example.test' },
  oidc: { issuer: 'https://gitlab.example.test', clientId: 'goalie', clientSecretRef: { name: 'oidc', key: 'client-secret' } },
  database: { urlSecretRef: { name: 'cnpg-app', key: 'uri' } },
};
const run = (args, values, success = true) => {
  const path = join(directory, 'values.json');
  writeFileSync(path, JSON.stringify(values));
  let error;
  try { execFileSync(helm, [...args, '-f', path], { stdio: 'pipe', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }); }
  catch (caught) { error = caught; }
  if (success && error) throw new Error(String(error.stderr || error.message));
  assert.equal(!error, success, `Unexpected chart result: ${JSON.stringify(values)}`);
};
try {
  run(['lint', '--strict', chart], base);
  run(['template', 'qualification', chart], base);
  run(['template', 'qualification', chart], {
    ...base, replicaCount: 2,
    database: { ...base.database, caSecretRef: { name: 'db-ca', key: 'ca.crt' } },
    trust: { caSecretRef: { name: 'trust', key: 'ca.crt' } },
    migration: { urlSecretRef: { name: 'migration-owner', key: 'uri' } },
    ingress: { enabled: true, className: 'existing', host: 'goalie.example.test', tlsSecretName: 'existing-tls' },
    pdb: { enabled: true }, networkPolicy: { enabled: true },
    openjev: { enabled: true, baseUrl: 'https://provider.example.test', trustedOrigin: 'https://provider.example.test', apiKeySecretRef: { name: 'provider', key: 'key' } },
  });
  run(['template', 'qualification', chart], { ...base, image: { repository: 'goalie', digest: '', tag: 'qualification', pullPolicy: 'Never' }, migration: { enabled: false } });
  for (const repository of ['localhost:5000/team/goalie', 'ghcr.io/org/work--item__app.v2']) {
    run(['template', 'qualification', chart], { ...base, image: { ...base.image, repository } });
  }
  const invalid = [
    {},
    { ...base, image: { repository: 'goalie', tag: 'latest', digest: '', pullPolicy: 'IfNotPresent' } },
    { ...base, image: { repository: 'goalie', digest: 'sha256:bad' } },
    ...['registry.example.test/goalie:latest', 'goalie@sha256:abc', 'goalie other', 'goalie\ninjected: true', '[goalie]', 'https://registry.example.test/goalie'].map(repository => ({
      ...base, image: { ...base.image, repository },
    })),
    { ...base, app: { ...base.app, maxRequestBodyBytes: 1023 } },
    { ...base, app: { ...base.app, maxRequestBodyBytes: 20000001 } },
    { ...base, app: { url: 'http://goalie.example.test' } },
    { ...base, app: { url: 'https://user:password@goalie.example.test' } },
    { ...base, database: { urlSecretRef: { name: 'missing-key' } } },
    { ...base, pdb: { enabled: true } },
    { ...base, ingress: { enabled: true, className: 'existing', host: 'wrong.example.test', tlsSecretName: 'tls' } },
    { ...base, openjev: { enabled: true } },
    { ...base, openjev: { enabled: true, baseUrl: 'https://provider.example.test', trustedOrigin: 'https://wrong.example.test', apiKeySecretRef: { name: 'provider', key: 'key' } } },
    { ...base, containerSecurityContext: { readOnlyRootFilesystem: false } },
    { ...base, probes: { liveness: { path: '/health' } } },
    { ...base, probes: { readiness: { path: '/livez' } } },
    { ...base, probes: { startup: { path: '/health' } } },
  ];
  for (const values of invalid) run(['template', 'qualification', chart], values, false);
  console.log(`Chart lint/render passed: production, local, optional features; ${invalid.length} invalid configurations rejected. No cluster/CNI/ingress claim.`);
} finally { rmSync(directory, { recursive: true, force: true }); }
