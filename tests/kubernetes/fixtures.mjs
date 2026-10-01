import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { hash } from 'bcryptjs';


export const POSTGRES_IMAGE = 'docker.io/library/postgres:18.1@sha256:2ccc3d98b960df5ed1ee2d32d3d5338a3c688cf899c0e951ce6d45fb07395abc';
export const DEX_IMAGE = 'registry-1.docker.io/dexidp/dex@sha256:8499afd690c437f52301efd2b05b2455da5bd2dfc20332cd697dc9937f808462';

const POSTGRES_SERVICE = 'goalie-postgres';
const DEX_SERVICE = 'goalie-dex';
const PROVIDER_SERVICE = 'goalie-provider';
const APP_SERVICE = 'goalie';
const DB_USER = 'goalie';
const DB_PASSWORD = 'goalie-fixture-password';
const DB_NAME = 'goalie';
const DEX_CLIENT_ID = 'goalie';
const DEX_CLIENT_SECRET = 'goalie-fixture-client-secret';
const DEX_EDITOR_PASSWORD = 'password';
const PROVIDER_API_KEY = 'synthetic-openjev-key';

const b64 = value => Buffer.from(value).toString('base64');
const yamlSecret = (name, namespace, data, type = 'Opaque') => ({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace }, type, data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, b64(value)])) });
const labels = (component, namespace) => ({ 'app.kubernetes.io/name': 'goalie-fixture', 'app.kubernetes.io/component': component, 'app.kubernetes.io/part-of': 'goalie-acceptance', 'goalie.fixture/namespace': namespace });
const dns = value => { assert.match(value, /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/); return value; };
const serviceHost = (name, namespace) => `${name}.${namespace}.svc.cluster.local`;

async function invoke(run, command, args, options = {}) {
 assert.equal(typeof run, 'function', 'createFixtures requires a run(command, args, options?) helper');
 const result = await run(command, args, options);
 if (typeof result === 'string') return { stdout: result, stderr: '' };
 return result ?? { stdout: '', stderr: '' };
}

async function openssl(run, directory, args) {
 await invoke(run, 'openssl', args, { cwd: directory, timeout: 30_000 });
}

async function createCertificateAuthority(run, directory) {
 const caKey = join(directory, 'fixture-ca.key');
 const caCert = join(directory, 'fixture-ca.crt');
 await openssl(run, directory, ['req', '-x509', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-keyout', caKey, '-out', caCert, '-subj', '/CN=Goalie Kubernetes Fixture CA']);
 await chmod(caKey, 0o600);
 await chmod(caCert, 0o600);
 return { key: caKey, cert: caCert };
}

async function createLeafCertificate(run, directory, ca, name, hosts) {
 const key = join(directory, `${name}.key`);
 const csr = join(directory, `${name}.csr`);
 const cert = join(directory, `${name}.crt`);
 const ext = join(directory, `${name}.ext`);
 await writeFile(ext, ['authorityKeyIdentifier=keyid,issuer', 'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}`, ''].join('\n'), { mode: 0o600 });
 await openssl(run, directory, ['req', '-new', '-nodes', '-newkey', 'rsa:2048', '-keyout', key, '-out', csr, '-subj', `/CN=${hosts[0]}`]);
 await openssl(run, directory, ['x509', '-req', '-sha256', '-days', '2', '-in', csr, '-CA', ca.cert, '-CAkey', ca.key, '-CAcreateserial', '-out', cert, '-extfile', ext]);
 await chmod(key, 0o600);
 await chmod(cert, 0o600);
 return { key, cert };
}

async function readCertFiles(cert) {
 return { cert: await readFile(cert.cert, 'utf8'), key: await readFile(cert.key, 'utf8') };
}

function postgresObjects({ fixtureNamespace, postgresCert, caText }) {
 const dbLabels = labels('postgres', fixtureNamespace);
 return [
  yamlSecret('goalie-postgres-tls', fixtureNamespace, { 'ca.crt': caText, 'tls.crt': postgresCert.cert, 'tls.key': postgresCert.key }, 'kubernetes.io/tls'),
  { apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: { name: 'goalie-postgres-data', namespace: fixtureNamespace, labels: dbLabels }, spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: '1Gi' } } } },
  {
   apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: POSTGRES_SERVICE, namespace: fixtureNamespace, labels: dbLabels },
   spec: {
    replicas: 1, selector: { matchLabels: dbLabels }, template: {
     metadata: { labels: dbLabels }, spec: {
      securityContext: { runAsNonRoot: true, runAsUser: 999, runAsGroup: 999, fsGroup: 999 },
      containers: [{
       name: 'postgres', image: POSTGRES_IMAGE, imagePullPolicy: 'IfNotPresent', args: ['postgres', '-c', 'ssl=on', '-c', 'ssl_cert_file=/tls/tls.crt', '-c', 'ssl_key_file=/tls/tls.key', '-c', 'ssl_ca_file=/tls/ca.crt'], env: [
        { name: 'POSTGRES_USER', value: DB_USER }, { name: 'POSTGRES_PASSWORD', value: DB_PASSWORD }, { name: 'POSTGRES_DB', value: DB_NAME }, { name: 'PGDATA', value: '/var/lib/postgresql/18/docker' },
       ], ports: [{ name: 'postgres', containerPort: 5432 }], readinessProbe: { exec: { command: ['pg_isready', '-U', DB_USER, '-d', DB_NAME] }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 }, volumeMounts: [{ name: 'tls', mountPath: '/tls', readOnly: true }, { name: 'data', mountPath: '/var/lib/postgresql' }]
      }],
      volumes: [{ name: 'tls', secret: { secretName: 'goalie-postgres-tls', defaultMode: 0o440 } }, { name: 'data', persistentVolumeClaim: { claimName: 'goalie-postgres-data' } }],
     }
    }
   },
  },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: POSTGRES_SERVICE, namespace: fixtureNamespace, labels: dbLabels }, spec: { type: 'ClusterIP', selector: dbLabels, ports: [{ name: 'postgres', port: 5432, targetPort: 'postgres' }] } },
 ];
}

function dexObjects({ fixtureNamespace, dexCert, dexConfig }) {
 const dexLabels = labels('dex', fixtureNamespace);
 return [
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'goalie-dex-config', namespace: fixtureNamespace, labels: dexLabels }, data: { 'config.yaml': dexConfig } },
  yamlSecret('goalie-dex-tls', fixtureNamespace, { 'tls.crt': dexCert.cert, 'tls.key': dexCert.key }, 'kubernetes.io/tls'),
  {
   apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: DEX_SERVICE, namespace: fixtureNamespace, labels: dexLabels },
   spec: {
    replicas: 1, selector: { matchLabels: dexLabels }, template: {
     metadata: { labels: dexLabels }, spec: {
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, fsGroup: 1000 },
      containers: [{ name: 'dex', image: DEX_IMAGE, imagePullPolicy: 'IfNotPresent', args: ['dex', 'serve', '/etc/dex/config.yaml'], ports: [{ name: 'https', containerPort: 5554 }], readinessProbe: { httpGet: { scheme: 'HTTPS', path: '/dex/.well-known/openid-configuration', port: 'https' }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 }, volumeMounts: [{ name: 'config', mountPath: '/etc/dex', readOnly: true }, { name: 'tls', mountPath: '/tls', readOnly: true }, { name: 'data', mountPath: '/data' }] }],
      volumes: [{ name: 'config', configMap: { name: 'goalie-dex-config' } }, { name: 'tls', secret: { secretName: 'goalie-dex-tls', defaultMode: 0o440 } }, { name: 'data', emptyDir: {} }],
     }
    }
   }
  },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: DEX_SERVICE, namespace: fixtureNamespace, labels: dexLabels }, spec: { type: 'ClusterIP', selector: dexLabels, ports: [{ name: 'https', port: 5554, targetPort: 'https' }] } },
 ];
}

function providerObjects({ fixtureNamespace, provider, image }) {
 assert(image, 'providerObjects(image) requires the already-built app image; no fixture image is rebuilt');
 const providerLabels = labels('provider', fixtureNamespace);
 return [
  yamlSecret('goalie-provider-tls', fixtureNamespace, { 'tls.crt': provider.certText, 'tls.key': provider.keyText }, 'kubernetes.io/tls'),
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'goalie-provider-script', namespace: fixtureNamespace, labels: providerLabels }, data: { 'provider.mjs': provider.script } },
  {
   apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: PROVIDER_SERVICE, namespace: fixtureNamespace, labels: providerLabels },
   spec: {
    replicas: 1, selector: { matchLabels: providerLabels }, template: {
     metadata: { labels: providerLabels }, spec: {
      securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532 },
      containers: [{ name: 'provider', image, imagePullPolicy: 'Never', command: ['/usr/local/bin/bun', '--no-env-file', '/etc/provider/provider.mjs'], ports: [{ name: 'https', containerPort: 8443 }], readinessProbe: { httpGet: { scheme: 'HTTPS', path: '/health', port: 'https' }, periodSeconds: 2, timeoutSeconds: 2, failureThreshold: 30 }, volumeMounts: [{ name: 'script', mountPath: '/etc/provider', readOnly: true }, { name: 'tls', mountPath: '/tls', readOnly: true }, { name: 'requests', mountPath: '/run/provider' }] }],
      volumes: [{ name: 'script', configMap: { name: 'goalie-provider-script' } }, { name: 'tls', secret: { secretName: 'goalie-provider-tls', defaultMode: 0o440 } }, { name: 'requests', emptyDir: { medium: 'Memory', sizeLimit: '1Mi' } }],
     }
    }
   },
  },
  { apiVersion: 'v1', kind: 'Service', metadata: { name: PROVIDER_SERVICE, namespace: fixtureNamespace, labels: providerLabels }, spec: { type: 'ClusterIP', selector: providerLabels, ports: [{ name: 'https', port: 8443, targetPort: 'https' }] } },
 ];
}

function appSecrets({ namespace, databaseUrl, caText }) {
 return [
  yamlSecret('goalie-database', namespace, { url: databaseUrl }),
  yamlSecret('goalie-database-ca', namespace, { 'ca.crt': caText }),
  yamlSecret('goalie-trust-ca', namespace, { 'ca.crt': caText }),
  yamlSecret('goalie-oidc-client', namespace, { secret: DEX_CLIENT_SECRET }),
  yamlSecret('goalie-openjev', namespace, { 'api-key': PROVIDER_API_KEY }),
 ];
}

const providerScript = `import { appendFile, readFile } from 'node:fs/promises';\nimport { createServer } from 'node:https';\nconst tls = { key: await readFile('/tls/tls.key'), cert: await readFile('/tls/tls.crt') };\nconst log = '/run/provider/requests.jsonl';\nconst server = createServer(tls, async (request, response) => {\n  const chunks = []; for await (const chunk of request) chunks.push(chunk);\n  const body = Buffer.concat(chunks).toString();\n  await appendFile(log, JSON.stringify({ method: request.method, url: request.url, authorization: request.headers.authorization ?? null, body }) + '\\n');\n  if (request.url === '/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ status: 'ok' })); return; }\n  if (request.method !== 'POST' || request.url !== '/v1/systemone' || request.headers.authorization !== 'Bearer ${PROVIDER_API_KEY}') { response.writeHead(404); response.end(); return; }\n  let parsed; try { parsed = JSON.parse(body); } catch { response.writeHead(400); response.end(JSON.stringify({ error: 'invalid json' })); return; }\n  const answers = {}; for (const [key, question] of Object.entries(parsed.questions ?? {})) { if (question.type === 'choice') { const first = Object.keys(question.criteria ?? {})[0] ?? 'yes'; answers[key] = { type: 'choice', choice: first, probabilities: { [first]: 1 } }; } else answers[key] = { type: 'noul', noul: 0.5 }; }\n  response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ model: parsed.model ?? 'openjev-latest', answers }));\n});\nserver.listen(8443, '0.0.0.0');\n`;

/**
 * Generate private TLS material and Kubernetes-only synthetic dependencies.
 * `run(command, args, options?)` must execute argv without a shell and return either
 * stdout text or { stdout, stderr }. CA private keys are only returned as paths and
 * are never included in diagnostics by this module.
 */
export async function createFixtures({ directory, namespace = 'goalie-app', fixtureNamespace = 'goalie-fixtures', run }) {
 assert(directory, 'directory is required');
 dns(namespace); dns(fixtureNamespace); assert.notEqual(namespace, fixtureNamespace, 'app and fixture namespaces must be separate');
 const root = resolve(directory);
 await mkdir(root, { recursive: true, mode: 0o700 });
 await chmod(root, 0o700);
 const ca = await createCertificateAuthority(run, root);
 const postgresHost = serviceHost(POSTGRES_SERVICE, fixtureNamespace);
 const dexHost = serviceHost(DEX_SERVICE, fixtureNamespace);
 const providerHost = serviceHost(PROVIDER_SERVICE, fixtureNamespace);
 const postgresCert = await createLeafCertificate(run, root, ca, 'postgres', [POSTGRES_SERVICE, postgresHost, `${POSTGRES_SERVICE}.${fixtureNamespace}.svc`]);
 const dexCert = await createLeafCertificate(run, root, ca, 'dex', [DEX_SERVICE, dexHost, `${DEX_SERVICE}.${fixtureNamespace}.svc`]);
 const providerCert = await createLeafCertificate(run, root, ca, 'provider', [PROVIDER_SERVICE, providerHost, `${PROVIDER_SERVICE}.${fixtureNamespace}.svc`]);
 const caText = await readFile(ca.cert, 'utf8');
 const postgresPem = await readCertFiles(postgresCert);
 const dexPem = await readCertFiles(dexCert);
 const providerPem = await readCertFiles(providerCert);
 const appURL = `https://${APP_SERVICE}.${namespace}.svc.cluster.local`;
 const dexIssuer = `https://${dexHost}:5554/dex`;
 const dexPasswordHash = await hash(DEX_EDITOR_PASSWORD, 10);
 const databaseUrl = `postgresql://${encodeURIComponent(DB_USER)}:${encodeURIComponent(DB_PASSWORD)}@${postgresHost}:5432/${DB_NAME}?sslmode=verify-full`;
 const dexConfig = [
  `issuer: ${dexIssuer}`,
  'enablePasswordDB: true',
  'storage:', '  type: sqlite3', '  config:', '    file: /data/dex.db',
  'web:', '  https: 0.0.0.0:5554', '  tlsCert: /tls/tls.crt', '  tlsKey: /tls/tls.key',
  'staticClients:', `- id: ${DEX_CLIENT_ID}`, `  secret: ${DEX_CLIENT_SECRET}`, '  name: Goalie Kubernetes Fixture', `  redirectURIs: [${appURL}/auth/callback]`,
  'staticPasswords:', `- email: goalie-editor@example.test`, `  hash: ${dexPasswordHash}`, '  username: editor', '  userID: synthetic-editor',
  '',
 ].join('\n');
 const base = { apiVersion: 'v1', kind: 'Namespace' };
 const objects = [
  { ...base, metadata: { name: namespace, labels: { 'pod-security.kubernetes.io/enforce': 'restricted', 'pod-security.kubernetes.io/audit': 'restricted', 'pod-security.kubernetes.io/warn': 'restricted', 'goalie.fixture/owned': 'true' } } },
  { ...base, metadata: { name: fixtureNamespace, labels: { 'goalie.fixture/owned': 'true', 'pod-security.kubernetes.io/enforce': 'baseline' } } },
  ...postgresObjects({ fixtureNamespace, postgresCert: postgresPem, caText }),
  ...dexObjects({ fixtureNamespace, dexCert: dexPem, dexConfig }),
  ...appSecrets({ namespace, databaseUrl, caText }),
 ];
 const provider = {
  serviceName: PROVIDER_SERVICE, namespace: fixtureNamespace, secretName: 'goalie-provider-tls', caFile: ca.cert, certFile: providerCert.cert, keyFile: providerCert.key, baseUrl: `https://${providerHost}:8443`, trustedOrigin: `https://${providerHost}:8443`, apiKey: PROVIDER_API_KEY, requestPath: '/v1/systemone', healthPath: '/health', requestLogPath: '/run/provider/requests.jsonl', certText: providerPem.cert, keyText: providerPem.key, script: providerScript,
  objects: image => providerObjects({ fixtureNamespace, provider, image }),
 };
 const values = {
  image: { repository: 'goalie', digest: '', tag: 'ci', pullPolicy: 'Never' }, replicaCount: 1, app: { url: appURL, maxRequestBodyBytes: 2_000_000, bootstrapEmail: 'goalie-editor@example.test' },
  oidc: { issuer: dexIssuer, clientId: DEX_CLIENT_ID, clientSecretRef: { name: 'goalie-oidc-client', key: 'secret' } },
  database: { urlSecretRef: { name: 'goalie-database', key: 'url' }, caSecretRef: { name: 'goalie-database-ca', key: 'ca.crt' }, poolMax: 10 }, trust: { caSecretRef: { name: 'goalie-trust-ca', key: 'ca.crt' } },
  migration: { enabled: true, urlSecretRef: {} }, openjev: { enabled: false },
 };
 const providerValues = { ...values, openjev: { enabled: true, baseUrl: provider.baseUrl, trustedOrigin: provider.trustedOrigin, model: 'openjev-latest', timeoutMs: 30_000, apiKeySecretRef: { name: 'goalie-openjev', key: 'api-key' } } };
 return {
  objects, values, providerValues, postgresImage: POSTGRES_IMAGE, dexImage: DEX_IMAGE,
  namespace, fixtureNamespace, appURL, appServiceName: APP_SERVICE,
  postgres: { serviceName: POSTGRES_SERVICE, namespace: fixtureNamespace, host: postgresHost, url: databaseUrl, secretName: 'goalie-database', caSecretName: 'goalie-database-ca', caFile: ca.cert, certFile: postgresCert.cert, keyFile: postgresCert.key, username: DB_USER, password: DB_PASSWORD, database: DB_NAME, invalidUrl: databaseUrl.replace(DB_PASSWORD, 'invalid-fixture-password') },
  dex: { serviceName: DEX_SERVICE, namespace: fixtureNamespace, host: dexHost, issuer: dexIssuer, clientId: DEX_CLIENT_ID, clientSecret: DEX_CLIENT_SECRET, editorEmail: 'goalie-editor@example.test', editorUsername: 'editor', editorPassword: DEX_EDITOR_PASSWORD, caFile: ca.cert, certFile: dexCert.cert, keyFile: dexCert.key, secretName: 'goalie-oidc-client' },
  provider, caFile: ca.cert, caKeyFile: ca.key,
  synthetic: { personId: 'demo-editor', email: 'goalie-editor@example.test', workItemId: 'fixture-work-item', title: 'Kubernetes fixture work', expectedRevision: 1 },
  serviceNames: { app: APP_SERVICE, postgres: POSTGRES_SERVICE, dex: DEX_SERVICE, provider: PROVIDER_SERVICE },
 };
}

export function syntheticWorkCommands({ leadId, expectedRevision = 0 } = {}) {
 assert(leadId, 'syntheticWorkCommands requires the authenticated editor person ID');
 return [
  { expectedRevision, command: { type: 'workstream.create', workstream: { title: 'Kubernetes fixture stream', description: 'Synthetic acceptance workstream.', leadId, goalIds: [] } } },
 ];
}

/**
 * Insert a workstream and item through the application service. `request` is an
 * authenticated service callback accepting a command request and returning the
 * decoded `/api/work` JSON (`{ data: snapshot }`); it owns OIDC cookies/CSRF.
 */
export async function insertSyntheticWork({ request, leadId, expectedRevision = 0 } = {}) {
 assert.equal(typeof request, 'function', 'insertSyntheticWork requires an authenticated service request callback');
 const streamResponse = await request(syntheticWorkCommands({ leadId, expectedRevision })[0]);
 const streamSnapshot = streamResponse?.data ?? streamResponse;
 const stream = streamSnapshot?.workstreams?.find(value => value.title === 'Kubernetes fixture stream');
 assert(stream, 'application service did not return the synthetic workstream');
 const itemResponse = await request({ expectedRevision: streamSnapshot.revision, command: { type: 'item.create', item: { title: 'Kubernetes fixture work', description: 'Synthetic Kubernetes acceptance item.', workstreamId: stream.id, parentId: null, status: 'todo', assigneeIds: [leadId], dueDate: null, blocker: '', tagIds: [] } } });
 const itemSnapshot = itemResponse?.data ?? itemResponse;
 const item = itemSnapshot?.items?.find(value => value.title === 'Kubernetes fixture work' && value.workstreamId === stream.id);
 assert(item, 'application service did not return the synthetic work item');
 return { stream, item, snapshot: itemSnapshot };
}

export { providerObjects };