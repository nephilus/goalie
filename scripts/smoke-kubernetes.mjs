import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import * as fixtureModule from '../tests/kubernetes/fixtures.mjs';
const execFileAsync = promisify(execFile);
const KIND_NODE_IMAGE = 'kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f';
const MAX_DIAGNOSTIC_BYTES = 24 * 1024;
const COMMAND_TIMEOUT = 120_000;
const HELM_TIMEOUT = '10m';

const args = process.argv.slice(2);
const image = args[0];
const engine = process.env.CONTAINER_ENGINE || 'docker';
const expectedRevision = process.env.EXPECTED_REVISION;
assert(['docker', 'podman'].includes(engine), 'CONTAINER_ENGINE must be docker or podman');
assert(image && !image.startsWith('-') && args.length === 1, 'Usage: node scripts/smoke-kubernetes.mjs <image>');
assert(expectedRevision, 'EXPECTED_REVISION is required');

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const releaseVersion = packageJson.version;
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const clusterName = `goalie-smoke-${suffix}`;
const contextName = `kind-${clusterName}`;
const appNamespace = `goalie-app-${suffix}`;
const fixtureNamespace = `goalie-fixtures-${suffix}`;
const releaseName = `goalie-smoke-${suffix}`;
const localImage = `localhost/goalie-smoke:${suffix}`;
const owned = { cluster: false, tag: false, tempDirectory: '', fixture: undefined };
const redactions = new Set([image, localImage, expectedRevision]);
let diagnosticsDirectory = '';
let terminating = false;
let syntheticAuth;
let cleaning = false;

const bounded = value => String(value ?? '').slice(-MAX_DIAGNOSTIC_BYTES);
const redact = value => {
  let output = String(value ?? '');
  for (const secret of redactions) if (secret) output = output.split(secret).join('[redacted]');
  output = output.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-certificate]');
  output = output.replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, '$1[redacted]');
  output = output.replace(/(authorization:\s*bearer\s+)[^\s]+/gi, '$1[redacted]');
  return bounded(output);
};

const errorText = error => redact([error?.stdout, error?.stderr].filter(Boolean).join('\n') || error?.message || error);

function commandError(command, commandArgs, error) {
  const detail = errorText(error) || 'command failed';
  return new Error(`${command} ${commandArgs.join(' ')} failed: ${detail}`);
}

async function runProcess(command, commandArgs, options = {}) {
  const { input, timeout = COMMAND_TIMEOUT, allowFailure = false, env = process.env, cwd } = options;
  try {
    if (input !== undefined) {
      return await new Promise((resolve, reject) => {
        const child = spawn(command, commandArgs, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), timeout);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', code => {
          clearTimeout(timer);
          const result = { stdout, stderr, code: code ?? 1 };
          if (result.code !== 0 && !allowFailure) reject(commandError(command, commandArgs, result));
          else resolve(result);
        });
        child.stdin.end(input);
      });
    }
    const result = await execFileAsync(command, commandArgs, { cwd, env, timeout, maxBuffer: 8 * 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    if (allowFailure) return { stdout: error.stdout || '', stderr: error.stderr || '', code: error.code || 1, error };
    throw commandError(command, commandArgs, error);
  }
}

function mustJson(text, description) {
  try { return JSON.parse(text); } catch { throw new Error(`${description} did not return JSON`); }
}

function kubectlArgs(commandArgs) {
  return ['--kubeconfig', owned.kubeconfig, '--context', contextName, ...commandArgs];
}
function helmArgs(commandArgs) {
  return ['--kubeconfig', owned.kubeconfig, '--kube-context', contextName, ...commandArgs];
}
async function kubectl(commandArgs, options = {}) { return runProcess('kubectl', kubectlArgs(commandArgs), options); }
async function helm(commandArgs, options = {}) { return runProcess('helm', helmArgs(commandArgs), { timeout: commandArgs.includes('--timeout') ? 11 * 60_000 : COMMAND_TIMEOUT, ...options }); }
async function kind(commandArgs, options = {}) { return runProcess('kind', commandArgs, { ...options, env: { ...process.env, KIND_EXPERIMENTAL_PROVIDER: process.env.KIND_EXPERIMENTAL_PROVIDER || (engine === 'podman' ? 'podman' : 'docker') } }); }
async function container(commandArgs, options = {}) { return runProcess(engine, commandArgs, options); }
async function runFixtureCommand(command, commandArgs, options = {}) {
  if (command === 'kubectl') return kubectl(commandArgs, options);
  if (command === 'helm') return helm(commandArgs, options);
  if (command === engine) return container(commandArgs, options);
  return runProcess(command, commandArgs, options);
}


function jsonFilePath(name) { return join(owned.tempDirectory, `${name}.json`); }
async function writeJson(name, value) {
  const path = jsonFilePath(name);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  return path;
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function applyObjects(objects, name) {
  const list = Array.isArray(objects) ? objects : [];
  if (!list.length) return;
  const directory = join(owned.tempDirectory, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [index, object] of list.entries()) {
    if (!object || typeof object !== 'object') continue;
    const items = object.kind === 'List' && Array.isArray(object.items) ? object.items : [object];
    for (const [itemIndex, item] of items.entries()) {
      await writeFile(join(directory, `${String(index).padStart(4, '0')}-${itemIndex}.json`), `${JSON.stringify(item)}\n`, { mode: 0o600 });
    }
  }
  await kubectl(['apply', '-f', directory]);
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override;
  const result = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(override)) result[key] = value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(result[key], value) : value;
  return result;
}

async function getJson(resourceArgs) { return mustJson((await kubectl([...resourceArgs, '-o', 'json'])).stdout, resourceArgs.join(' ')); }
async function getAppPods() {
  const result = await getJson(['get', 'pods', '-n', appNamespace, '-l', `app.kubernetes.io/name=goalie,app.kubernetes.io/instance=${releaseName},app.kubernetes.io/component=app`]);
  return result.items || [];
}
async function getRunningAppPod() {
  const pods = await getAppPods();
  return pods.find(pod => pod.status?.phase === 'Running' && !pod.metadata.deletionTimestamp);
}
async function getReadyAppPod() {
  const pods = await getAppPods();
  return pods.find(pod => pod.status?.phase === 'Running' && !pod.metadata.deletionTimestamp && pod.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
}
async function waitUntil(description, predicate, timeoutMs = 180_000, intervalMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline && !terminating) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${description} did not complete${lastError ? `: ${redact(lastError.message)}` : ''}`);
}

async function portForwardApp(callback) {
  const pod = await waitUntil('an application pod', getRunningAppPod, 120_000);
  const port = await freePort();
  const child = spawn('kubectl', kubectlArgs(['port-forward', '-n', appNamespace, '--address', '127.0.0.1', `pod/${pod.metadata.name}`, `${port}:4310`]), { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  try {
    await waitUntil('application port-forward', async () => output.includes('Forwarding from') || child.exitCode !== null, 20_000, 100);
    if (child.exitCode !== null) throw new Error(`port-forward exited: ${redact(output)}`);
    return await callback(`http://127.0.0.1:${port}`, pod);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => { const timer = setTimeout(resolve, 3_000); child.once('close', () => { clearTimeout(timer); resolve(); }); });
  }
}

async function appRequest(path, init = {}) {
  return portForwardApp(async origin => {
    const response = await fetch(`${origin}${path}`, { redirect: 'manual', ...init, signal: init.signal || AbortSignal.timeout(10_000) });
    const body = await response.arrayBuffer();
    return new Response(body.byteLength ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
  });
}

async function imageIdentity(reference) {
  const inspected = mustJson((await container(['image', 'inspect', reference])).stdout, 'container image inspect');
  const entry = Array.isArray(inspected) ? inspected[0] : inspected;
  assert.equal(entry.Architecture, 'amd64', 'Image architecture must be native amd64');
  assert.equal(entry.Config?.Labels?.['org.opencontainers.image.revision'], expectedRevision, 'Image revision label mismatch');
  assert.equal(entry.Config?.Labels?.['org.opencontainers.image.version'], releaseVersion, 'Image version label mismatch');
  return { id: entry.Id, labels: entry.Config?.Labels || {}, repoDigests: entry.RepoDigests || [] };
}

async function loadImage(identity = imageIdentity(image)) {
  await container(['tag', image, localImage]);
  owned.tag = true;
  const tagged = await imageIdentity(localImage);
  assert.equal(tagged.id, identity.id, 'Local image tag changed the image config identity');
  const archive = join(owned.tempDirectory, 'goalie-image.tar');
  const saveArgs = engine === 'podman' ? ['save', '--format', 'docker-archive', '--output', archive, localImage] : ['save', '--output', archive, localImage];
  await container(saveArgs);
  await kind(['load', 'image-archive', archive, '--name', clusterName]);
  const nodeName = `${clusterName}-control-plane`;
  const loaded = await container(['exec', nodeName, 'crictl', 'images', '-o', 'json']);
  const inventory = mustJson(loaded.stdout, 'node image inventory');
  const images = inventory.images || [];
  const loadedImage = images.find(entry => (entry.repoTags || []).includes(localImage));
  assert(loadedImage, 'The application image was not loaded into the kind node');
  assert(loadedImage.id || loadedImage.repoDigests?.length, 'Loaded image inventory did not expose an immutable image ID');
  if (loadedImage.id && identity.id.startsWith('sha256:')) assert.equal(loadedImage.id, identity.id, 'Loaded image config ID differs from the built image');
  return identity;
}

async function createCluster() {
  owned.kubeconfig = join(owned.tempDirectory, 'kubeconfig');
  const apiServerPort = await freePort();
  const config = `kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnetworking:\n  apiServerAddress: 127.0.0.1\n  apiServerPort: ${apiServerPort}\nnodes:\n- role: control-plane\n`;
  const configPath = join(owned.tempDirectory, 'kind.yaml');
  await writeFile(configPath, config, { mode: 0o600 });
  const existing = await kind(['get', 'clusters'], { allowFailure: true });
  assert(!existing.stdout.split(/\s+/).includes(clusterName), 'Refusing to reuse an existing kind cluster name');
  owned.cluster = true;
  await kind(['create', 'cluster', '--name', clusterName, '--image', KIND_NODE_IMAGE, '--config', configPath, '--kubeconfig', owned.kubeconfig]);
  const current = (await kubectl(['config', 'current-context'])).stdout.trim();
  assert.equal(current, contextName, 'kind did not create the expected private context');
  await kubectl(['cluster-info']);
}

async function namespaceSetup() {
  await kubectl(['create', 'namespace', appNamespace]);
  await kubectl(['label', 'namespace', appNamespace, 'pod-security.kubernetes.io/enforce=restricted', 'pod-security.kubernetes.io/audit=restricted', 'pod-security.kubernetes.io/warn=restricted', '--overwrite']);
  await kubectl(['create', 'namespace', fixtureNamespace]);
  await kubectl(['label', 'namespace', fixtureNamespace, 'pod-security.kubernetes.io/enforce=baseline', 'pod-security.kubernetes.io/audit=baseline', 'pod-security.kubernetes.io/warn=baseline', '--overwrite']);
}

async function buildProviderObjects(fixture) {
  assert.equal(typeof fixture.provider?.objects, 'function', 'Fixture provider.objects(image) is required');
  return fixture.provider.objects(localImage);
}


async function waitFixtureWorkloads(fixture, additionalObjects = []) {
  const workloadObjects = [...fixture.objects, ...additionalObjects];
  const seen = new Set();
  for (const object of workloadObjects) {
    if (!['Deployment', 'StatefulSet'].includes(object?.kind) || object.metadata?.namespace !== fixtureNamespace) continue;
    const kind = object.kind === 'Deployment' ? 'deployment' : 'statefulset';
    const name = object.metadata.name;
    if (seen.has(`${kind}/${name}`)) continue;
    seen.add(`${kind}/${name}`);
    await kubectl(['rollout', 'status', `${kind}/${name}`, '-n', fixtureNamespace, '--timeout=180s'], { timeout: 210_000 });
  }
  await waitUntil('fixture pods', async () => {
    const result = await kubectl(['get', 'pods', '-n', fixtureNamespace, '-o', 'json'], { allowFailure: true });
    if (result.code) return false;
    const pods = mustJson(result.stdout, 'fixture pod list').items || [];
    return pods.length > 0 && pods.every(p => p.status?.phase === 'Running' && p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
  }, 180_000);
}

async function chartValues(fixture) {
  const values = deepMerge({}, fixture.values || {});
  values.image = { ...(values.image || {}), repository: localImage.split(':')[0], tag: localImage.split(':').slice(1).join(':'), digest: '', pullPolicy: 'Never' };
  values.replicaCount = 1;
  values.migration = { ...(values.migration || {}), enabled: true };
  values.podAnnotations = { ...(values.podAnnotations || {}), 'goalie.smoke/revision': expectedRevision };
  return values;
}

async function packageChart(valuesPath) {
  const packageDirectory = join(owned.tempDirectory, 'chart-package');
  await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
  await helm(['lint', 'charts/goalie', '--values', valuesPath]);
  await helm(['package', 'charts/goalie', '--destination', packageDirectory, '--version', releaseVersion, '--app-version', releaseVersion]);
  const files = await readdir(packageDirectory);
  const chart = files.find(file => file.endsWith('.tgz'));
  assert(chart, 'Helm did not produce a packaged chart');
  const chartPath = join(packageDirectory, chart);
  const metadata = await helm(['show', 'chart', chartPath]);
  assert(!/^dependencies:/m.test(metadata.stdout), 'Packaged chart unexpectedly declares dependencies');
  const entries = await runProcess('tar', ['-tzf', chartPath]);
  assert(!entries.stdout.split('\n').some(path => path.startsWith('goalie/charts/')), 'Packaged chart unexpectedly bundles subcharts');
  return chartPath;
}

async function renderServerDryRuns(chartPath, values) {
  const ingressHost = new URL(values.app.url).hostname;
  const variants = [
    { name: 'ingress', values: deepMerge(values, { ingress: { enabled: true, className: 'nginx', host: ingressHost, tlsSecretName: 'goalie-ingress-tls' } }) },
    { name: 'pdb', values: deepMerge(values, { replicaCount: 2, pdb: { enabled: true, minAvailable: 1 } }) },
    { name: 'networkpolicy', values: deepMerge(values, { networkPolicy: { enabled: true, ingress: [{ from: [] }], egress: [{ to: [] }] } }) },
  ];
  for (const variant of variants) {
    const variantPath = await writeJson(`values-${variant.name}`, variant.values);
    const rendered = await helm(['template', releaseName, chartPath, '--namespace', appNamespace, '--values', variantPath]);
    const renderedPath = join(owned.tempDirectory, `rendered-${variant.name}.yaml`);
    await writeFile(renderedPath, rendered.stdout, { mode: 0o600 });
    await kubectl(['apply', '--dry-run=server', '--validate=strict', '-f', renderedPath, '-n', appNamespace]);
  }
}

async function installChart(chartPath, valuesPath) {
  await helm(['install', releaseName, chartPath, '--namespace', appNamespace, '--values', valuesPath, '--wait', '--timeout', HELM_TIMEOUT]);
  await helm(['test', releaseName, '--namespace', appNamespace, '--logs', '--timeout', HELM_TIMEOUT]);
  await waitUntil('application readiness', async () => {
    const response = await appRequest('/health');
    return response.status === 200;
  }, 180_000);
}

async function revisionAndImageCheck() {
  const deployment = await getJson(['get', 'deployment', releaseName, '-n', appNamespace]);
  const appContainer = deployment.spec.template.spec.containers.find(c => c.name === 'goalie');
  assert.equal(appContainer.image, localImage, 'Deployment does not use the preloaded image tag');
  const pod = await waitUntil('application pod image identity', getReadyAppPod, 120_000);
  const status = pod.status?.containerStatuses?.find(c => c.name === 'goalie');
  assert(status?.imageID && /sha256:/.test(status.imageID), 'Kubernetes reported no immutable imageID');
  assert.equal((await imageIdentity(localImage)).labels['org.opencontainers.image.revision'], expectedRevision);
}

const sqlLiteral = value => `'${String(value).replaceAll("'", "''")}'`;
async function databasePod() {
  const selector = 'app.kubernetes.io/name=goalie-fixture,app.kubernetes.io/component=postgres';
  return waitUntil('PostgreSQL fixture pod', async () => {
    const list = await getJson(['get', 'pods', '-n', fixtureNamespace, '-l', selector]);
    return list.items?.find(pod => pod.status?.phase === 'Running');
  }, 120_000);
}
async function databaseQuery(fixture, query) {
  const pod = await databasePod();
  const database = fixture.postgres;
  return kubectl(['exec', '-n', fixtureNamespace, pod.metadata.name, '-c', 'postgres', '--', 'psql', '-U', database.username, '-d', database.database, '-v', 'ON_ERROR_STOP=1', '-tAc', query]);
}
async function migrationLedgerCheck(fixture) {
  const files = (await readdir(new URL('../migrations/', import.meta.url))).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  const expected = await Promise.all(files.map(async file => ({ version: file.slice(0, file.indexOf('_')), checksum: createHash('sha256').update(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8')).digest('hex') })));
  const rows = (await databaseQuery(fixture, 'SELECT version,checksum FROM schema_migrations ORDER BY version')).stdout.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const [version, checksum] = line.split('|');
    return { version: version.trim(), checksum: checksum.trim() };
  });
  assert.deepEqual(rows, expected, 'Kubernetes migration ledger does not match every bundled migration checksum');
}
async function establishSyntheticSession(fixture) {
  const rawSession = `smoke-session-${randomUUID()}`;
  const csrfToken = `smoke-csrf-${randomUUID()}`;
  const hash = value => createHash('sha256').update(value).digest('hex');
  const person = fixture.synthetic.personId;
  await databaseQuery(fixture, `INSERT INTO people(id,name,email,team,role) VALUES(${sqlLiteral(person)},'Synthetic Editor',${sqlLiteral(fixture.synthetic.email)},'Acceptance','editor') ON CONFLICT (id) DO NOTHING; INSERT INTO sessions(id_hash,person_id,csrf_hash,expires_at) VALUES(${sqlLiteral(hash(rawSession))},${sqlLiteral(person)},${sqlLiteral(hash(csrfToken))},now()+interval '1 hour') ON CONFLICT (id_hash) DO UPDATE SET expires_at=excluded.expires_at;`);
  const origin = new URL(fixture.appURL).origin;
  const cookieScope = createHash('sha256').update(origin).digest('hex').slice(0, 16);
  syntheticAuth = { rawSession, csrfToken, cookie: `goalie_${cookieScope}_session=${encodeURIComponent(rawSession)}; goalie_${cookieScope}_csrf=${encodeURIComponent(csrfToken)}`, origin };
}
async function authenticatedWorkRequest(command) {
  const response = await appRequest('/api/work', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', Cookie: syntheticAuth.cookie, Origin: syntheticAuth.origin, 'X-CSRF-Token': syntheticAuth.csrfToken }, body: JSON.stringify(command) });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Application service work command failed (${response.status}): ${JSON.stringify(body)}`);
  return body;
}
async function seedSyntheticWork(fixture, fixtureModule) {
  await establishSyntheticSession(fixture);
  const revision = Number((await databaseQuery(fixture, 'SELECT revision FROM simple_workspace WHERE id=1')).stdout.trim());
  assert.equal(typeof fixtureModule.insertSyntheticWork, 'function', 'Kubernetes fixture must export insertSyntheticWork');
  return fixtureModule.insertSyntheticWork({ request: authenticatedWorkRequest, leadId: fixture.synthetic.personId, expectedRevision: revision });
}
async function workStillExists(work) {
  const response = await appRequest('/api/work', { redirect: 'manual', headers: { Cookie: syntheticAuth.cookie, Origin: syntheticAuth.origin } });
  const body = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `Application service snapshot failed (${response.status})`);
  const id = work.item.id;
  assert(body.data?.items?.some(item => item.id === id), `Synthetic work item ${id} was not persisted`);
  return body.data;
}


async function deploymentTemplate() { return getJson(['get', 'deployment', releaseName, '-n', appNamespace]); }

async function migrationFailureCheck(chartPath, values, fixture, work) {
  const beforeData = await workStillExists(work);
  const idempotent = deepMerge(values, { podAnnotations: { ...(values.podAnnotations || {}), 'goalie.smoke/idempotent-upgrade': randomUUID() } });
  const idempotentPath = await writeJson('values-idempotent-upgrade', idempotent);
  await helm(['upgrade', releaseName, chartPath, '--namespace', appNamespace, '--values', idempotentPath, '--wait', '--timeout', HELM_TIMEOUT]);
  await waitUntil('application readiness after idempotent upgrade', async () => (await appRequest('/health')).status === 200, 180_000);
  const afterData = await workStillExists(work);
  assert.equal(afterData.revision, beforeData.revision, 'Idempotent migration changed workspace revision');
  assert(afterData.items.some(item => item.id === work.item.id && item.title === work.item.title), 'Idempotent migration changed the persisted work item');
  await migrationLedgerCheck(fixture);
  const before = await deploymentTemplate();
  const badSecret = `goalie-invalid-migration-${suffix}`;
  await kubectl(['create', 'secret', 'generic', badSecret, '-n', appNamespace, `--from-literal=url=${fixture.postgres.invalidUrl}`]);
  const badValues = deepMerge(idempotent, { migration: { urlSecretRef: { name: badSecret, key: 'url' } } });
  const badValuesPath = await writeJson('values-invalid-migration', badValues);
  const failed = await helm(['upgrade', releaseName, chartPath, '--namespace', appNamespace, '--values', badValuesPath, '--wait', '--timeout', '5m'], { allowFailure: true });
  assert.notEqual(failed.code, 0, 'Upgrade with invalid migration credentials unexpectedly succeeded');
  const after = await deploymentTemplate();
  assert.equal(after.spec.template.spec.containers.find(c => c.name === 'goalie').image, before.spec.template.spec.containers.find(c => c.name === 'goalie').image, 'Failed migration changed the application image');
  assert.deepEqual(after.spec.template.metadata?.annotations || {}, before.spec.template.metadata?.annotations || {}, 'Failed migration changed the Deployment template');
  await kubectl(['delete', 'secret', badSecret, '-n', appNamespace, '--ignore-not-found=true']);
  const restored = deepMerge(idempotent, { podAnnotations: { ...(idempotent.podAnnotations || {}), 'goalie.smoke/recovery': randomUUID() } });
  const restoredPath = await writeJson('values-restored', restored);
  await helm(['upgrade', releaseName, chartPath, '--namespace', appNamespace, '--values', restoredPath, '--wait', '--timeout', HELM_TIMEOUT]);
  await waitUntil('application readiness after migration recovery', async () => (await appRequest('/health')).status === 200, 180_000);
  await migrationLedgerCheck(fixture);
  return restored;
}

async function readinessAndLivenessCheck(fixture) {
  const database = fixture.postgres;
  const workloadName = database.serviceName;
  assert(database?.serviceName, 'PostgreSQL fixture must expose serviceName');
  const appPodBefore = await getReadyAppPod();
  const restartCounts = new Map((await getAppPods()).map(p => [p.metadata.uid, p.status.containerStatuses?.find(c => c.name === 'goalie')?.restartCount || 0]));
  await kubectl(['scale', `deployment/${workloadName}`, '--replicas=0', '-n', fixtureNamespace]);
  await waitUntil('database outage readiness withdrawal', async () => (await appRequest('/health')).status === 503, 120_000);
  await waitUntil('readiness endpoint withdrawal', async () => {
    const slices = await getJson(['get', 'endpointslice', '-n', appNamespace, '-l', `kubernetes.io/service-name=${releaseName}`]);
    return !(slices.items || []).some(slice => (slice.endpoints || []).some(endpoint => endpoint.conditions?.ready === true));
  }, 30_000, 1_000);
  assert.equal((await appRequest('/livez')).status, 200, 'livez failed during a database outage');
  const outageDeadline = Date.now() + 35_000;
  while (Date.now() < outageDeadline) {
    for (const pod of await getAppPods()) {
      const previous = restartCounts.get(pod.metadata.uid) ?? 0;
      const current = pod.status.containerStatuses?.find(c => c.name === 'goalie')?.restartCount || 0;
      assert.equal(current, previous, 'Liveness restarted the application during a database outage');
    }
    await new Promise(resolve => setTimeout(resolve, 5_000));
  }
  await kubectl(['scale', `deployment/${workloadName}`, '--replicas=1', '-n', fixtureNamespace]);
  await waitFixtureWorkloads(fixture);
  await waitUntil('database recovery readiness', async () => (await appRequest('/health')).status === 200, 180_000);
  await waitUntil('database recovery pod readiness', getReadyAppPod, 30_000);
  assert(appPodBefore, 'Application pod disappeared unexpectedly during database outage');
}

async function restartAndTerminationCheck(work) {
  const oldPod = await getReadyAppPod();
  assert(oldPod, 'A ready application pod is required for restart check');
  const oldUid = oldPod.metadata.uid;
  await kubectl(['delete', 'pod', oldPod.metadata.name, '-n', appNamespace, '--wait=false']);
  const replacement = await waitUntil('owned application pod recreation', async () => {
    const pods = await getAppPods();
    return pods.find(p => p.metadata.uid !== oldUid && p.status?.phase === 'Running' && p.status.conditions?.some(c => c.type === 'Ready' && c.status === 'True'));
  }, 120_000);
  assert(await workStillExists(work), 'Synthetic work did not survive application pod recreation');
  const terminationPod = replacement;
  const beforeCount = terminationPod.status.containerStatuses.find(c => c.name === 'goalie')?.restartCount || 0;
  const terminationStarted = Date.now();
  await kubectl(['exec', '-n', appNamespace, terminationPod.metadata.name, '-c', 'goalie', '--', '/usr/local/bin/bun', '--no-env-file', '-e', 'process.kill(1, "SIGTERM")'], { allowFailure: true });
  const terminated = await waitUntil('SIGTERM termination observation', async () => {
    const pod = (await getAppPods()).find(p => p.metadata.uid === terminationPod.metadata.uid);
    const status = pod?.status?.containerStatuses?.find(c => c.name === 'goalie');
    const state = status?.lastState?.terminated || status?.state?.terminated;
    if (state && ((status?.restartCount || 0) > beforeCount || state.signal === 15 || state.reason === 'Completed')) return state;
    return false;
  }, 30_000, 500);
  assert(Date.now() - terminationStarted < 30_000, 'Application exceeded its 30-second SIGTERM shutdown window');
  assert(terminated.signal === 15 || (terminated.reason === 'Completed' && terminated.exitCode === 0), `Application did not record a graceful SIGTERM termination: ${JSON.stringify(terminated)}`);
  const events = await kubectl(['get', 'events', '-n', appNamespace, '--field-selector', `involvedObject.name=${terminationPod.metadata.name}`, '-o', 'json'], { allowFailure: true });
  assert(!/FailedKillPod|kill.*timeout/i.test(events.stdout), 'Kubernetes forced SIGKILL after application SIGTERM');
  await waitUntil('application readiness after SIGTERM', async () => (await appRequest('/health')).status === 200, 120_000);
}

async function patchSecret(secretName, key, value) {
  const patch = { data: { [key]: Buffer.from(value).toString('base64') } };
  await kubectl(['patch', 'secret', secretName, '-n', appNamespace, '--type=merge', '--patch', JSON.stringify(patch)]);
}
async function restartDeployment(waitReady = true) {
  const existing = await getAppPods();
  const existingUids = new Set(existing.map(pod => pod.metadata.uid));
  await kubectl(['rollout', 'restart', 'deployment', releaseName, '-n', appNamespace]);
  for (const pod of existing) await kubectl(['delete', 'pod', pod.metadata.name, '-n', appNamespace, '--wait=false'], { allowFailure: true });
  await waitUntil('replacement application pod', async () => (await getAppPods()).find(pod => !existingUids.has(pod.metadata.uid) && pod.status?.phase === 'Running' && !pod.metadata.deletionTimestamp), 120_000);
  if (waitReady) await kubectl(['rollout', 'status', 'deployment', releaseName, '-n', appNamespace, '--timeout=180s'], { timeout: 210_000 });
}

async function caChecks(fixture) {
  const dbCa = fixture.values.database.caSecretRef;
  const trustCa = fixture.values.trust.caSecretRef;
  const dbCaText = await readFile(fixture.postgres.caFile, 'utf8');
  const trustCaText = await readFile(fixture.dex.caFile, 'utf8');
  assert(dbCa?.name && dbCa?.key, 'Fixture values must expose the database CA Secret reference');
  assert(trustCa?.name && trustCa?.key, 'Fixture values must expose the OIDC CA Secret reference');
  const wrongKey = join(owned.tempDirectory, 'wrong-ca.key');
  const wrongCert = join(owned.tempDirectory, 'wrong-ca.crt');
  await runFixtureCommand('openssl', ['req', '-x509', '-new', '-nodes', '-newkey', 'rsa:2048', '-sha256', '-days', '2', '-keyout', wrongKey, '-out', wrongCert, '-subj', '/CN=Untrusted Goalie Smoke CA']);
  const wrongCa = await readFile(wrongCert, 'utf8');
  await patchSecret(dbCa.name, dbCa.key, wrongCa);
  await restartDeployment(false);
  await waitUntil('wrong database CA failure', async () => (await appRequest('/health')).status === 503, 60_000);
  await patchSecret(dbCa.name, dbCa.key, dbCaText);
  await restartDeployment(true);
  await waitUntil('correct database CA recovery', async () => (await appRequest('/health')).status === 200, 120_000);
  const login = await appRequest('/auth/login');
  assert.equal(login.status, 302, 'Correct OIDC CA did not permit Dex discovery/login');
  assert(new URL(login.headers.get('location')).pathname.includes('/auth'), 'OIDC login did not redirect to the Dex authorization endpoint');
  await patchSecret(trustCa.name, trustCa.key, wrongCa);
  await restartDeployment(true);
  const wrongLogin = await appRequest('/auth/login');
  assert(wrongLogin.status >= 500, `Untrusted OIDC CA unexpectedly allowed discovery (${wrongLogin.status})`);
  await patchSecret(trustCa.name, trustCa.key, trustCaText);
  await restartDeployment(true);
  await waitUntil('OIDC CA recovery', async () => (await appRequest('/auth/login')).status === 302, 120_000);
}

async function providerInferenceRequestCount(fixture) {
  const pods = await getJson(['get', 'pods', '-n', fixtureNamespace, '-l', 'app.kubernetes.io/name=goalie-fixture,app.kubernetes.io/component=provider']);
  const pod = pods.items?.find(item => item.status?.phase === 'Running');
  assert(pod, 'Provider fixture pod is required for AI configuration acceptance');
  const script = `const fs = require('node:fs'); const path = ${JSON.stringify(fixture.provider.requestLogPath)}; if (fs.existsSync(path)) process.stdout.write(fs.readFileSync(path, 'utf8'));`;
  const log = await kubectl(['exec', '-n', fixtureNamespace, pod.metadata.name, '-c', 'provider', '--', '/usr/local/bin/bun', '--no-env-file', '-e', script]);
  return log.stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter(entry => entry.url === fixture.provider.requestPath).length;
}
async function securityAndAiChecks(fixture, baseValues, chartPath, work) {
  const badPod = { apiVersion: 'v1', kind: 'Pod', metadata: { name: `forbidden-${suffix}`, namespace: appNamespace }, spec: { containers: [{ name: 'bad', image: localImage, command: ['/usr/local/bin/bun', '--no-env-file', '-e', 'setTimeout(() => {}, 60000)'], securityContext: { privileged: true, runAsUser: 0, allowPrivilegeEscalation: true } }] } };
  const badPodPath = await writeJson('forbidden-pod', badPod);
  const denied = await kubectl(['apply', '-f', badPodPath], { allowFailure: true });
  assert.notEqual(denied.code, 0, 'Pod Security Restricted admitted an unsafe application pod');
  const pod = await waitUntil('application pod for rootfs check', getReadyAppPod, 120_000);
  const writeProbe = await kubectl(['exec', '-n', appNamespace, pod.metadata.name, '-c', 'goalie', '--', '/usr/local/bin/bun', '--no-env-file', '-e', "await Bun.write('/app/.smoke-write', 'x')"], { allowFailure: true });
  assert.notEqual(writeProbe.code, 0, 'Read-only application root filesystem accepted a write');
  const provider = fixture.provider;
  assert(provider?.apiKey, 'Provider fixture must expose a synthetic API key');
  assert.equal((await appRequest('/livez')).status, 200);
  const disabledStatusResponse = await appRequest('/api/work', { headers: { Cookie: syntheticAuth.cookie, Origin: syntheticAuth.origin } });
  const disabledStatus = await disabledStatusResponse.json();
  assert.equal(disabledStatusResponse.status, 200);
  assert.equal(disabledStatus.assist?.enabled, false, 'Application did not report AI disabled by default');
  const disabledRequests = await providerInferenceRequestCount(fixture);
  assert.equal(disabledRequests, 0, 'AI-disabled application made an inference request');
  const baseProviderValues = deepMerge(baseValues, { openjev: { enabled: false } });
  const baseProviderPath = await writeJson('values-ai-disabled', baseProviderValues);
  await helm(['upgrade', releaseName, chartPath, '--namespace', appNamespace, '--values', baseProviderPath, '--wait', '--timeout', HELM_TIMEOUT]);
  const enabled = deepMerge(baseValues, { openjev: fixture.providerValues.openjev });
  const enabledPath = await writeJson('values-ai-enabled', enabled);
  await helm(['upgrade', releaseName, chartPath, '--namespace', appNamespace, '--values', enabledPath, '--wait', '--timeout', HELM_TIMEOUT]);
  await waitUntil('AI-enabled readiness', async () => (await appRequest('/health')).status === 200, 180_000);
  await migrationLedgerCheck(fixture);
  const aiPod = await getReadyAppPod();
  const aiProbe = await kubectl(['exec', '-n', appNamespace, aiPod.metadata.name, '-c', 'goalie', '--', '/usr/local/bin/bun', '--no-env-file', '-e', `const fs = require('node:fs'); const st = fs.statSync('/run/goalie/openjev/api-key'); const env = fs.readFileSync('/proc/1/environ', 'utf8').split('\\0'); console.log(JSON.stringify({ mode: st.mode & 0o777, uid: st.uid, gid: st.gid, enabled: env.includes('OPENJEV_ENABLED=true'), baseUrl: env.find(v => v.startsWith('OPENJEV_BASE_URL=')) }));`]);
  const observed = JSON.parse(aiProbe.stdout.trim().split(/\n/).at(-1));
  assert.deepEqual({ mode: observed.mode, uid: observed.uid, gid: observed.gid }, { mode: 0o600, uid: 65532, gid: 65532 }, 'Projected OpenJev key has incorrect ownership or mode');
  assert(observed.enabled && observed.baseUrl, 'Application did not recognize enabled provider configuration');
  const enabledStatusResponse = await appRequest('/api/work', { headers: { Cookie: syntheticAuth.cookie, Origin: syntheticAuth.origin } });
  const enabledStatus = await enabledStatusResponse.json();
  assert.equal(enabledStatusResponse.status, 200);
  assert.equal(enabledStatus.assist?.enabled, true, 'Application service did not recognize the enabled provider configuration');
  assert.equal(enabledStatus.assist?.model, 'openjev-latest');
  const requests = await providerInferenceRequestCount(fixture);
  assert.equal(requests, disabledRequests, 'AI fixture received an inference request during configuration-only acceptance');
  await workStillExists(work);
}

async function collectDiagnostics(reason) {
  diagnosticsDirectory = await mkdtemp(join(tmpdir(), 'goalie-kubernetes-diagnostics-'));
  const sections = [`reason: ${redact(reason)}`, `cluster: ${clusterName}`, `namespace: ${appNamespace}`];
  if (!owned.cluster || !owned.kubeconfig) {
    await writeFile(join(diagnosticsDirectory, 'diagnostics.txt'), `${bounded(sections.join('\n'))}\n`, { mode: 0o600 });
    return diagnosticsDirectory;
  }
  const commands = [
    ['kubectl get pods -A -o wide', () => kubectl(['get', 'pods', '-A', '-o', 'wide'], { allowFailure: true })],
    ['kubectl get jobs -A', () => kubectl(['get', 'jobs', '-A'], { allowFailure: true })],
    ['kubectl get events -A', () => kubectl(['get', 'events', '-A', '--sort-by=.lastTimestamp'], { allowFailure: true })],
    ['helm status', () => helm(['status', releaseName, '-n', appNamespace], { allowFailure: true })],
    ['app logs', () => kubectl(['logs', '-n', appNamespace, '-l', `app.kubernetes.io/instance=${releaseName},app.kubernetes.io/component=app`, '--all-containers=true', '--tail=120'], { allowFailure: true })],
    ['migration logs', () => kubectl(['logs', '-n', appNamespace, `job/${releaseName}-migration`, '--all-containers=true', '--tail=120'], { allowFailure: true })],
  ];
  for (const [label, operation] of commands) {
    try { const result = await operation(); sections.push(`\n## ${label}\n${redact(result.stdout)}\n${redact(result.stderr)}`); } catch (error) { sections.push(`\n## ${label}\n${redact(error)}`); }
  }
  await writeFile(join(diagnosticsDirectory, 'diagnostics.txt'), `${bounded(sections.join('\n'))}\n`, { mode: 0o600 });
  return diagnosticsDirectory;
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  if (owned.cluster) await kind(['delete', 'cluster', '--name', clusterName, '--kubeconfig', owned.kubeconfig], { allowFailure: true }).catch(() => { });
  if (owned.tag) await container(['rmi', localImage], { allowFailure: true }).catch(() => { });
  if (owned.tempDirectory) await rm(owned.tempDirectory, { recursive: true, force: true }).catch(() => { });
}

for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  if (terminating) return;
  terminating = true;
  await cleanup();
  process.exit(signal === 'SIGINT' ? 130 : 143);
});

let currentFixture;
const reportDirectory = process.env.KUBERNETES_REPORT_DIRECTORY;
const writeReport = async report => {
  if (!reportDirectory) return;
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(reportDirectory, 'kubernetes.json'), JSON.stringify({
    schemaVersion: 1, revision: expectedRevision, version: releaseVersion, ...report,
  }, null, 2) + '\n', { mode: 0o600 });
};
try {
  await writeReport({ status: 'running' });
  owned.tempDirectory = await mkdtemp(join(tmpdir(), 'goalie-smoke-kubernetes-'));
  const sourceIdentity = await imageIdentity(image);
  await createCluster();
  await namespaceSetup();
  currentFixture = await fixtureModule.createFixtures({ directory: owned.tempDirectory, namespace: appNamespace, fixtureNamespace, run: runFixtureCommand });
  owned.fixture = currentFixture;
  assert.equal(currentFixture.postgresImage, fixtureModule.POSTGRES_IMAGE, 'Fixture PostgreSQL image digest is not the approved immutable amd64 pin');
  assert.equal(currentFixture.dexImage, fixtureModule.DEX_IMAGE, 'Fixture Dex image digest is not the approved immutable pin');
  const identity = await loadImage(sourceIdentity);
  const providerObjects = await buildProviderObjects(currentFixture);
  await applyObjects(currentFixture.objects, 'fixtures');
  await applyObjects(providerObjects, 'provider');
  await waitFixtureWorkloads(currentFixture, providerObjects);
  const values = await chartValues(currentFixture);
  const valuesPath = await writeJson('values', values);
  const chartPath = await packageChart(valuesPath);
  await renderServerDryRuns(chartPath, values);
  await installChart(chartPath, valuesPath);
  await revisionAndImageCheck();
  await migrationLedgerCheck(currentFixture);
  const work = await seedSyntheticWork(currentFixture, fixtureModule);
  await workStillExists(work);
  const restoredValues = await migrationFailureCheck(chartPath, values, currentFixture, work);
  await readinessAndLivenessCheck(currentFixture);
  await restartAndTerminationCheck(work);
  await caChecks(currentFixture);
  await securityAndAiChecks(currentFixture, restoredValues, chartPath, work);
  await workStillExists(work);
  if (reportDirectory) {
    const chartBytes = await readFile(chartPath);
    await writeFile(join(reportDirectory, 'qualified-chart.tgz'), chartBytes, { mode: 0o600 });
    await writeReport({
      status: 'passed', imageId: identity.id, architecture: 'amd64', qualifiedAt: new Date().toISOString(),
      chart: { file: 'qualified-chart.tgz', sha256: createHash('sha256').update(chartBytes).digest('hex'), version: releaseVersion, appVersion: releaseVersion },
      checks: ['migration-checksums', 'helm-test', 'upgrade-persistence', 'migration-failure-gate', 'database-outage-probes', 'pod-recreation', 'sigterm', 'database-and-oidc-tls', 'restricted-admission', 'read-only-rootfs', 'private-key-projection', 'no-provider-inference', 'optional-resources-server-dry-run'],
    });
  }
  console.log(`Kubernetes smoke passed: cluster ${clusterName}, image ${localImage} config ${identity.id}, migration/Helm, persistence, outage probes, restart/SIGTERM, TLS CA rejection, PSS/rootfs, AI projection, optional dry-runs, packaged chart`);
} catch (error) {
  const location = await collectDiagnostics(errorText(error)).catch(() => 'unavailable');
  await writeReport({ status: 'error', error: redact(errorText(error)), diagnostics: location }).catch(() => { });
  console.error(`Kubernetes smoke failed: ${redact(errorText(error))}`);
  console.error(`Redacted diagnostics: ${location}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
