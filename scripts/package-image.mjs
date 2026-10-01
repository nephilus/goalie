import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import {
 access,
 copyFile,
 mkdir,
 mkdtemp,
 readdir,
 readFile,
 rm,
 stat,
 writeFile,
 chmod,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { evaluateImageReport } from './scan-image.mjs';

const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT = 15 * 60 * 1000;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const KIND_NODE_IMAGE = 'kindest/node:v1.35.0@sha256:452d707d4862f52530247495d180205e029056831160e22870e37e3f6c1ac31f';
let activeKindCleanup = null;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => { throw new Error(message); };

function digest(value) {
 if (!nonEmptyString(value)) return null;
 const normalized = value.startsWith('sha256:') ? value : `sha256:${value}`;
 return IMAGE_ID.test(normalized) ? normalized : null;
}

function redact(value) {
 return String(value ?? '')
  .replace(/(password|token|authorization|secret|api[_-]?key)([=:][^\s"']+)/gi, '$1=[REDACTED]')
  .replace(/https?:\/\/[^\s@]+@/g, 'https://[REDACTED]@');
}

async function run(command, args, options = {}) {
 try {
  return await execFileAsync(command, args, {
   timeout: COMMAND_TIMEOUT,
   maxBuffer: 64 * 1024 * 1024,
   ...options,
  });
 } catch (error) {
  const output = error.stderr || error.stdout || error.message || 'command failed';
  throw new Error(`${command} ${args.join(' ')} failed: ${redact(output)}`, { cause: error });
 }
}

async function readJson(path, description) {
 let text;
 try { text = await readFile(path, 'utf8'); }
 catch (error) { throw new Error(`Missing ${description}: ${path}`, { cause: error }); }
 try { return JSON.parse(text); }
 catch (error) { throw new Error(`Invalid JSON in ${description}: ${path}`, { cause: error }); }
}

async function requireFile(path, description) {
 try {
  const details = await stat(path);
  if (!details.isFile() || details.size === 0) fail(`${description} is empty or not a regular file: ${path}`);
  return details;
 } catch (error) {
  if (error?.code === 'ENOENT') fail(`Missing ${description}: ${path}`);
  throw error;
 }
}

async function hashFile(path) {
 const hash = createHash('sha256');
 for await (const chunk of createReadStream(path)) hash.update(chunk);
 return hash.digest('hex');
}

async function writeJson(path, value) {
 await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
 await chmod(path, 0o600);
}

function isoTimestamp(value, description) {
 if (!nonEmptyString(value) || !Number.isFinite(Date.parse(value))) fail(`${description} must be an ISO timestamp`);
 return value;
}

function architectureOf(inspected) {
 const architecture = String(inspected?.Architecture || inspected?.Config?.Architecture || '').toLowerCase();
 return architecture === 'x86_64' ? 'amd64' : architecture;
}

function imageIdentityFromInspection(inspected, image, expectedRevision, version) {
 if (!isRecord(inspected)) fail('Container engine returned an invalid image inspection record');
 const imageId = digest(inspected.Id || inspected.ID);
 if (!imageId) fail('Container engine inspection did not provide a valid immutable config digest');
 const architecture = architectureOf(inspected);
 const os = String(inspected.Os || inspected.OS || inspected.Config?.Os || '').toLowerCase();
 if (os !== 'linux' || architecture !== 'amd64') fail(`Only linux/amd64 images are accepted (got ${os || 'unknown'}/${architecture || 'unknown'})`);
 const labels = inspected.Config?.Labels || inspected.Labels || {};
 if (!isRecord(labels)) fail('Container engine inspection returned invalid OCI labels');
 if (labels['org.opencontainers.image.revision'] !== expectedRevision) {
  fail(`Image revision label does not match EXPECTED_REVISION (${expectedRevision})`);
 }
 if (labels['org.opencontainers.image.version'] !== version) {
  fail(`Image version label does not match package.json (${version})`);
 }
 const sizeBytes = Number(inspected.Size);
 if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) fail('Container engine inspection did not provide a positive image size');
 const baseImagePins = Object.fromEntries(Object.entries(labels).filter(([key]) => /^org\.opencontainers\.image\.base\./.test(key)));
 const baseDigests = Object.entries(baseImagePins).filter(([key, value]) => /digest/i.test(key) || /@sha256:[a-f0-9]{64}/i.test(String(value)));
 if (baseDigests.length === 0) fail('Image inspection did not provide an immutable base image digest label');
 for (const [key, value] of baseDigests) {
  if (!String(value).includes('sha256:') || !/sha256:[a-f0-9]{64}/i.test(String(value))) fail(`Base image label ${key} is not an immutable digest`);
 }
 return {
  image,
  imageId,
  configDigest: imageId,
  revision: expectedRevision,
  architecture,
  os,
  sizeBytes,
  baseImagePins,
  labels: {
   'org.opencontainers.image.revision': labels['org.opencontainers.image.revision'],
   'org.opencontainers.image.version': labels['org.opencontainers.image.version'],
   'org.opencontainers.image.source': labels['org.opencontainers.image.source'] || null,
  },
 };
}

async function inspectImage(engine, image, expectedRevision, version) {
 const { stdout } = await run(engine, ['image', 'inspect', image], { encoding: 'utf8' });
 let records;
 try { records = JSON.parse(stdout); }
 catch (error) { throw new Error('Container engine returned invalid image inspection JSON', { cause: error }); }
 if (!Array.isArray(records) || records.length !== 1) fail('Container engine did not inspect exactly one image');
 return imageIdentityFromInspection(records[0], image, expectedRevision, version);
}

function assertIdentityMatch(candidate, expected, description) {
 const candidateDigest = digest(candidate);
 if (candidateDigest !== expected) fail(`${description} does not match the inspected image config digest (${candidate || 'missing'} != ${expected})`);
}

function assertRevision(candidate, expected, description) {
 if (candidate !== expected) fail(`${description} does not match EXPECTED_REVISION`);
}

function validateScan(reportDirectory, image, expectedRevision, identity) {
 const summary = reportDirectory.summary;
 if (!isRecord(summary) || summary.status !== 'passed') fail('Image scan summary is not passed');
 if (summary.image !== image) fail(`Image scan was not run for ${image}`);
 assertRevision(summary.expectedRevision, expectedRevision, 'Image scan expectedRevision');
 if (!isRecord(summary.policy) || summary.policy.blockingCount !== 0) fail('Image scan contains blocking HIGH/CRITICAL findings');
 const scanIdentity = reportDirectory.identity;
 if (!isRecord(scanIdentity)) fail('Image scan identity is missing');
 if (scanIdentity.image !== image) fail('Image scan identity does not match the requested image');
 assertIdentityMatch(scanIdentity.configDigest || scanIdentity.imageId, identity.imageId, 'Image scan identity');
 assertRevision(scanIdentity.expectedRevision || scanIdentity.revision, expectedRevision, 'Image scan identity revision');
 if (scanIdentity.architecture !== 'amd64') fail('Image scan identity is not amd64');
 assertIdentityMatch(summary.imageConfigDigest || summary.imageId || summary.identity?.configDigest, identity.imageId, 'Image scan summary identity');
 if (summary.imageRevision !== expectedRevision) fail('Image scan summary revision does not match EXPECTED_REVISION');
 const size = Number(scanIdentity.sizeBytes ?? summary.imageSizeBytes);
 if (!Number.isSafeInteger(size) || size <= 0 || size !== identity.sizeBytes) fail('Image scan size evidence does not match the inspected image');
 const scanBasePins = scanIdentity.baseImagePins;
 if (!isRecord(scanBasePins)) fail('Image scan did not record base image pins');
 for (const [key, value] of Object.entries(identity.baseImagePins)) {
  if (scanBasePins[key] !== value) fail(`Image scan base image pin ${key} does not match the inspected image`);
 }
 const scanTimestamp = isoTimestamp(summary.finishedAt || summary.startedAt, 'Image scan timestamp');
 return { scanTimestamp, scanIdentity };
}

function validateTrivy(report, identity) {
 assertIdentityMatch(report?.Metadata?.ImageID, identity.imageId, 'Trivy report image identity');
 const policy = evaluateImageReport(report);
 if (policy.blocking.length !== 0) fail('Full Trivy report contains fixable HIGH/CRITICAL findings');
}

function validateQualification(qualification, expectedRevision, identity) {
 if (!isRecord(qualification) || qualification.status !== 'passed') fail('qualification.json does not record a passed qualification');
 assertIdentityMatch(qualification.imageId, identity.imageId, 'Qualification image identity');
 assertRevision(qualification.revision, expectedRevision, 'Qualification revision');
 if (qualification.containerSmoke !== 'passed' || qualification.kubernetes !== 'passed') fail('qualification.json does not record successful container and Kubernetes smoke tests');
 const qualifiedAt = isoTimestamp(qualification.qualifiedAt, 'Qualification timestamp');
 return { status: 'passed', imageId: identity.imageId, revision: expectedRevision, containerSmoke: 'passed', kubernetes: 'passed', qualifiedAt };
}

function validateKubernetesEvidence(evidence, expectedRevision, version, identity) {
 if (!isRecord(evidence) || evidence.schemaVersion !== 1 || evidence.status !== 'passed') fail('kubernetes.json does not record a passed Kubernetes qualification');
 assertIdentityMatch(evidence.imageId, identity.imageId, 'Kubernetes qualification image identity');
 assertRevision(evidence.revision, expectedRevision, 'Kubernetes qualification revision');
 if (evidence.version !== version) fail('Kubernetes qualification version does not match package.json');
 if (evidence.architecture !== 'amd64') fail('Kubernetes qualification architecture is not amd64');
 const qualifiedAt = isoTimestamp(evidence.qualifiedAt, 'Kubernetes qualification timestamp');
 if (!Array.isArray(evidence.checks) || evidence.checks.length === 0 || evidence.checks.some(check => !nonEmptyString(check))) fail('Kubernetes qualification checks are missing');
 if (!isRecord(evidence.chart)) fail('Kubernetes qualification chart evidence is missing');
 if (evidence.chart.file !== 'qualified-chart.tgz') fail('Kubernetes qualification chart must be qualified-chart.tgz');
 if (!SHA256.test(evidence.chart.sha256 || '')) fail('Kubernetes qualification chart hash is invalid');
 if (evidence.chart.version !== version || evidence.chart.appVersion !== version) fail('Kubernetes qualification chart version does not match package.json');
 return { schemaVersion: 1, status: 'passed', imageId: identity.imageId, revision: expectedRevision, version, architecture: 'amd64', qualifiedAt, chart: { file: 'qualified-chart.tgz', sha256: evidence.chart.sha256, version, appVersion: version }, checks: [...evidence.checks] };
}

function parseHelmScalar(text, key) {
 const match = String(text).split(/\r?\n/).find(line => new RegExp(`^${key}:\\s*`).test(line));
 if (!match) return null;
 const value = match.slice(match.indexOf(':') + 1).trim();
 if (!value) return '';
 if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
 return value;
}

function hasHelmDependencies(text) {
 const lines = String(text).split(/\r?\n/);
 const index = lines.findIndex(line => /^dependencies:\s*/.test(line));
 if (index < 0) return false;
 const value = lines[index].slice(lines[index].indexOf(':') + 1).trim();
 if (value && value !== '[]') return true;
 for (let current = index + 1; current < lines.length; current += 1) {
  if (/^\s+-\s+/.test(lines[current])) return true;
  if (/^[A-Za-z][A-Za-z0-9_-]*:\s*/.test(lines[current])) break;
 }
 return false;
}

async function verifyHelmChart(chartPath, version) {
 const helm = process.env.HELM || 'helm';
 const { stdout } = await run(helm, ['show', 'chart', chartPath], { encoding: 'utf8' });
 if (parseHelmScalar(stdout, 'version') !== version) fail('Qualified Helm chart version does not match package.json');
 if (parseHelmScalar(stdout, 'appVersion') !== version) fail('Qualified Helm chart appVersion does not match package.json');
 if (hasHelmDependencies(stdout)) fail('Qualified Helm chart declares dependencies');
}

async function inspectChartArchive(chartPath, version) {
 const { stdout: listing } = await run('tar', ['-tzf', chartPath], { encoding: 'utf8' });
 const entries = listing.split(/\r?\n/).filter(Boolean);
 if (entries.length === 0) fail('Qualified Helm chart archive is empty');
 if (entries.some(entry => /(^|\/)charts\//i.test(entry))) fail('Qualified Helm chart archive contains dependencies');
 if (entries.some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) fail('Qualified Helm chart archive contains an unsafe path');
 if (entries.some(entry => /(^|\/)(?:fixtures?|private|secrets?|credentials?|\.env(?:[./_-].*)?)(?:\/|$)/i.test(entry))) fail('Qualified Helm chart archive contains private fixture or credential material');
 const chartEntry = entries.find(entry => /(^|\/)Chart\.yaml$/.test(entry));
 if (!chartEntry) fail('Qualified Helm chart archive does not contain Chart.yaml');
 const { stdout: chartYaml } = await run('tar', ['-xOf', chartPath, chartEntry], { encoding: 'utf8' });
 if (parseHelmScalar(chartYaml, 'version') !== version || parseHelmScalar(chartYaml, 'appVersion') !== version) fail('Qualified Helm chart metadata does not match package.json');
 if (hasHelmDependencies(chartYaml)) fail('Qualified Helm chart declares dependencies');
 await verifyHelmChart(chartPath, version);
}

async function dockerArchiveIdentity(archivePath, identity) {
 const { stdout: manifestText } = await run('tar', ['-xOf', archivePath, 'manifest.json'], { encoding: 'utf8' });
 let manifest;
 try { manifest = JSON.parse(manifestText); } catch (error) { throw new Error('Image export is not a valid Docker archive', { cause: error }); }
 if (!Array.isArray(manifest) || manifest.length !== 1 || !isRecord(manifest[0]) || !nonEmptyString(manifest[0].Config)) fail('Docker archive must contain exactly one immutable config entry');
 const configPath = manifest[0].Config;
 const { stdout: configBytes } = await run('tar', ['-xOf', archivePath, configPath], { encoding: null });
 if (!Buffer.isBuffer(configBytes)) fail('Docker archive config was not returned as bytes');
 const configDigest = `sha256:${createHash('sha256').update(configBytes).digest('hex')}`;
 if (configDigest !== identity.imageId) fail(`Docker archive config digest ${configDigest} does not match inspected image ${identity.imageId}`);
 let config;
 try { config = JSON.parse(configBytes.toString('utf8')); } catch (error) { throw new Error('Docker archive config JSON is invalid', { cause: error }); }
 if (config.config?.Labels?.['org.opencontainers.image.revision'] !== identity.revision) fail('Docker archive config revision label does not match EXPECTED_REVISION');
 return { configDigest, configPath };
}

async function saveImage(engine, image, identity, directory) {
 const archivePath = join(directory, 'goalie-image.tar');
 const args = engine === 'podman'
  ? ['save', '--format', 'docker-archive', '--output', archivePath, image]
  : ['save', '--output', archivePath, image];
 await run(engine, args, { encoding: 'utf8' });
 const details = await requireFile(archivePath, 'Docker image archive');
 const archive = await dockerArchiveIdentity(archivePath, identity);
 return { path: archivePath, bytes: details.size, sha256: await hashFile(archivePath), ...archive };
}

async function freePort() {
 const server = createServer();
 await new Promise((resolvePromise, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolvePromise);
 });
 const address = server.address();
 const port = typeof address === 'object' && address ? address.port : null;
 await new Promise((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
 if (!Number.isInteger(port) || port <= 0) fail('Unable to allocate a private loopback API port for kind');
 return port;
}

async function verifyKindRoundtrip(engine, archivePath, identity, directory) {
 const kind = process.env.KIND || 'kind';
 const clusterName = `goalie-package-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
 const kubeconfig = join(directory, 'kubeconfig');
 const configPath = join(directory, 'kind.yaml');
 const apiServerPort = await freePort();
 await writeFile(configPath, `kind: Cluster\napiVersion: kind.x-k8s.io/v1alpha4\nnetworking:\n  apiServerAddress: 127.0.0.1\n  apiServerPort: ${apiServerPort}\nnodes:\n- role: control-plane\n`, { mode: 0o600 });
 const environment = {
  ...process.env,
  KUBECONFIG: kubeconfig,
  KIND_EXPERIMENTAL_PROVIDER: engine === 'podman' ? 'podman' : 'docker',
 };
 let clusterCreated = false;
 let cleaned = false;
 const cleanup = async () => {
  if (cleaned) return;
  cleaned = true;
  if (clusterCreated) {
   try {
    await run(kind, ['delete', 'cluster', '--name', clusterName, '--kubeconfig', kubeconfig], { env: environment, timeout: 120_000 });
   } catch {
    // Cleanup is best effort after attempting to create the uniquely owned cluster.
   }
  }
  await rm(kubeconfig, { force: true }).catch(() => { });
  await rm(configPath, { force: true }).catch(() => { });
 };
 activeKindCleanup = cleanup;
 try {
  clusterCreated = true;
  await run(kind, ['create', 'cluster', '--name', clusterName, '--image', KIND_NODE_IMAGE, '--config', configPath, '--kubeconfig', kubeconfig, '--wait', '120s'], { env: environment });
  await chmod(kubeconfig, 0o600).catch(() => { });
  await run(kind, ['load', 'image-archive', archivePath, '--name', clusterName], { env: environment });
  const nodeName = `${clusterName}-control-plane`;
  const { stdout } = await run(engine, ['exec', nodeName, 'crictl', 'images', '-o', 'json'], { encoding: 'utf8' });
  let inventory;
  try { inventory = JSON.parse(stdout); }
  catch (error) { throw new Error('Owned kind node returned invalid image inventory JSON', { cause: error }); }
  const taggedCandidates = inventory.images.filter(entry => isRecord(entry)
   && Array.isArray(entry.repoTags)
   && entry.repoTags.some(tag => tag === identity.image || tag.endsWith(`/${identity.image}`)));
  const candidates = taggedCandidates.length > 0
   ? taggedCandidates
   : inventory.images.filter(entry => digest(entry?.id || entry?.ID) === identity.imageId);
  if (candidates.length !== 1) fail(`Owned kind node did not expose exactly one loaded ${identity.image} image`);
  const loadedImageId = digest(candidates[0].id || candidates[0].ID);
  if (!loadedImageId) fail('Owned kind node image inventory did not expose an immutable config ID');
  if (loadedImageId !== identity.imageId) fail(`Owned kind node loaded config ID ${loadedImageId} does not match ${identity.imageId}`);
  return { engine, provider: environment.KIND_EXPERIMENTAL_PROVIDER, nodeImage: KIND_NODE_IMAGE, clusterName, loadedImageId };
 } finally {
  await cleanup();
  if (activeKindCleanup === cleanup) activeKindCleanup = null;
 }
}

async function copyArtifact(source, destination, description) {
 await requireFile(source, description);
 await copyFile(source, destination);
 await chmod(destination, 0o600);
}

function safeVersion(version) {
 if (!nonEmptyString(version) || !/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2}(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) fail(`package.json version is not a supported release version: ${version || 'missing'}`);
 return version;
}

async function main() {
 const args = process.argv.slice(2);
 const [image, reportDirectoryArgument, outputDirectoryArgument] = args;
 if (args.length !== 3 || !image || image.startsWith('-') || !reportDirectoryArgument || !outputDirectoryArgument || reportDirectoryArgument.startsWith('-') || outputDirectoryArgument.startsWith('-')) {
  throw new Error('Usage: node scripts/package-image.mjs <image> <report-directory> <output-directory>');
 }
 const expectedRevision = process.env.EXPECTED_REVISION;
 const engine = process.env.CONTAINER_ENGINE;
 if (!nonEmptyString(expectedRevision) || expectedRevision.startsWith('-')) throw new Error('EXPECTED_REVISION is required');
 if (!['docker', 'podman'].includes(engine)) throw new Error('CONTAINER_ENGINE must be docker or podman');
 const reportDirectoryPath = resolve(reportDirectoryArgument);
 const outputDirectoryPath = resolve(outputDirectoryArgument);
 if (reportDirectoryPath === outputDirectoryPath) throw new Error('Report and output directories must be different');
 const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
 const version = safeVersion(packageJson.version);
 await access(reportDirectoryPath);
 await mkdir(outputDirectoryPath, { recursive: true, mode: 0o700 });
 const existingOutput = await readdir(outputDirectoryPath);
 if (existingOutput.length > 0) throw new Error('Output directory must be empty; refusing to overwrite an existing bundle');
 const report = {
  summary: await readJson(join(reportDirectoryPath, 'summary.json'), 'image scan summary'),
  identity: await readJson(join(reportDirectoryPath, 'image-identity.json'), 'image scan identity'),
  trivy: await readJson(join(reportDirectoryPath, 'trivy-report.json'), 'full Trivy report'),
  sbom: await readJson(join(reportDirectoryPath, 'sbom.cdx.json'), 'CycloneDX SBOM'),
  qualification: await readJson(join(reportDirectoryPath, 'qualification.json'), 'qualification evidence'),
  kubernetes: await readJson(join(reportDirectoryPath, 'kubernetes.json'), 'Kubernetes qualification evidence'),
 };
 if (!isRecord(report.sbom) || report.sbom.bomFormat !== 'CycloneDX' || !Array.isArray(report.sbom.components) || report.sbom.components.length === 0) fail('CycloneDX SBOM is missing or empty');
 const identity = await inspectImage(engine, image, expectedRevision, version);
 const scan = validateScan(report, image, expectedRevision, identity);
 validateTrivy(report.trivy, identity);
 const qualification = validateQualification(report.qualification, expectedRevision, identity);
 const kubernetes = validateKubernetesEvidence(report.kubernetes, expectedRevision, version, identity);
 if (digest(kubernetes.imageId) !== qualification.imageId) fail('Kubernetes and qualification image identities differ');
 const qualifiedChartPath = join(reportDirectoryPath, 'qualified-chart.tgz');
 await requireFile(qualifiedChartPath, 'qualified Helm chart');
 const qualifiedChartSha256 = await hashFile(qualifiedChartPath);
 if (qualifiedChartSha256 !== kubernetes.chart.sha256) fail('Qualified chart hash does not match kubernetes.json evidence');
 await inspectChartArchive(qualifiedChartPath, version);
 const temporaryDirectory = await mkdtemp(join(tmpdir(), 'goalie-package-'));
 try {
  const archive = await saveImage(engine, image, identity, temporaryDirectory);
  const chartFile = `goalie-${version}.tgz`;
  const artifactSources = [
   ['trivy-report.json', join(reportDirectoryPath, 'trivy-report.json'), 'full Trivy report'],
   ['sbom.cdx.json', join(reportDirectoryPath, 'sbom.cdx.json'), 'CycloneDX SBOM'],
   ['summary.json', join(reportDirectoryPath, 'summary.json'), 'image scan summary'],
   ['image-identity.json', join(reportDirectoryPath, 'image-identity.json'), 'image scan identity'],
   ['db-metadata.json', join(reportDirectoryPath, 'db-metadata.json'), 'Trivy database metadata'],
  ];
  for (const [, source, description] of artifactSources) await requireFile(source, description);
  const outputArchivePath = join(outputDirectoryPath, 'goalie-image.tar');
  await copyFile(archive.path, outputArchivePath);
  await chmod(outputArchivePath, 0o600);
  const outputArchiveSha256 = await hashFile(outputArchivePath);
  if (outputArchiveSha256 !== archive.sha256) fail('Final image archive changed while preparing the bundle');
  const roundtrip = await verifyKindRoundtrip(engine, outputArchivePath, identity, temporaryDirectory);
  await copyFile(qualifiedChartPath, join(outputDirectoryPath, chartFile));
  await chmod(join(outputDirectoryPath, chartFile), 0o600);
  for (const [name, source, description] of artifactSources) await copyArtifact(source, join(outputDirectoryPath, name), description);
  await writeJson(join(outputDirectoryPath, 'metadata.json'), { imageId: identity.imageId, revision: expectedRevision, version });
  await writeJson(join(outputDirectoryPath, 'qualification.json'), qualification);
  const kubernetesArtifact = { ...kubernetes, chart: { ...kubernetes.chart, file: chartFile } };
  await writeJson(join(outputDirectoryPath, 'kubernetes.json'), kubernetesArtifact);
  const payloadNames = ['goalie-image.tar', chartFile, 'metadata.json', 'trivy-report.json', 'sbom.cdx.json', 'summary.json', 'image-identity.json', 'db-metadata.json', 'qualification.json', 'kubernetes.json'];
  const payload = [];
  for (const file of payloadNames) {
   const path = join(outputDirectoryPath, file);
   const details = await requireFile(path, `bundle artifact ${file}`);
   payload.push({ path: file, sha256: await hashFile(path), bytes: details.size });
  }
  const bom = {
   schemaVersion: 1,
   sourceSHA: expectedRevision,
   revision: expectedRevision,
   version,
   architecture: identity.architecture,
   imageId: identity.imageId,
   sizeBytes: identity.sizeBytes,
   baseImagePins: identity.baseImagePins,
   scanTimestamp: scan.scanTimestamp,
   image: { reference: image, configDigest: identity.imageId, archive: 'goalie-image.tar', archiveSha256: archive.sha256, archiveBytes: archive.bytes },
   roundtrip: { ...roundtrip, archive: 'goalie-image.tar' },
   chart: { file: chartFile, sha256: qualifiedChartSha256, version, appVersion: version },
   scan: { status: 'passed', summary: 'summary.json', report: 'trivy-report.json', sbom: 'sbom.cdx.json', database: 'db-metadata.json', timestamp: scan.scanTimestamp },
   qualification: { file: 'qualification.json', status: qualification.status, qualifiedAt: qualification.qualifiedAt },
   kubernetes: { file: 'kubernetes.json', status: kubernetesArtifact.status, qualifiedAt: kubernetesArtifact.qualifiedAt, imageId: kubernetesArtifact.imageId, checks: kubernetesArtifact.checks },
   files: payload,
  };
  await writeJson(join(outputDirectoryPath, 'bom.json'), bom);
  const checksumNames = [...payloadNames, 'bom.json'].sort();
  const checksums = [];
  for (const file of checksumNames) checksums.push(`${await hashFile(join(outputDirectoryPath, file))}  ${file}`);
  await writeFile(join(outputDirectoryPath, 'SHA256SUMS'), `${checksums.join('\n')}\n`, { mode: 0o600 });
  await chmod(join(outputDirectoryPath, 'SHA256SUMS'), 0o600);
  console.log(`Offline image bundle created: ${outputDirectoryPath} (${identity.imageId}, ${version})`);
 } finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
 }
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
 const handleSignal = signal => {
  void (async () => {
   if (activeKindCleanup) await activeKindCleanup();
   process.exit(signal === 'SIGINT' ? 130 : 143);
  })();
 };
 process.once('SIGINT', handleSignal);
 process.once('SIGTERM', handleSignal);
 main().catch(error => {
  console.error(redact(error.message));
  process.exitCode = 1;
 });
}

export { main, hashFile, validateQualification, validateKubernetesEvidence };
