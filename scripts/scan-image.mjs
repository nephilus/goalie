import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const PINNED_TRIVY_VERSION = '0.74.0';
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const SUPPORTED_RUNTIME_TYPES = new Set(['bun', 'javascript', 'node-pkg', 'npm']);
const SEVERITIES = new Set(['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
const HIGH_IMPACT = new Set(['HIGH', 'CRITICAL']);
const execTimeout = 15 * 60 * 1000;

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => { throw new Error(message); };
const digest = value => {
 if (!nonEmptyString(value)) return null;
 const normalized = value.startsWith('sha256:') ? value : `sha256:${value}`;
 return IMAGE_ID.test(normalized) ? normalized : null;
};
const redact = value => String(value)
 .replace(/(password|token|authorization|secret|api[_-]?key)([=:][^\s"']+)/gi, '$1=[REDACTED]')
 .replace(/https?:\/\/[^\s@]+@/g, 'https://[REDACTED]@');

const run = async (command, args, options = {}) => {
 try {
  return await execFileAsync(command, args, {
   timeout: execTimeout,
   maxBuffer: 64 * 1024 * 1024,
   ...options,
  });
 } catch (error) {
  const output = error.stderr || error.stdout || error.message || 'command failed';
  throw new Error(`${command} ${args[0] || ''} failed: ${redact(output)}`, { cause: error });
 }
};

const writeJson = async (path, value) => {
 await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
};

const hashFile = async path => {
 const hash = createHash('sha256');
 for await (const chunk of createReadStream(path)) hash.update(chunk);
 return hash.digest('hex');
};

const imageIdFromInspect = inspected => {
 const value = digest(inspected?.Id || inspected?.ID);
 if (!value) fail('Image inspection did not provide a valid immutable config digest');
 return value;
};

const inspectIdentity = (inspected, image, expectedRevision, engine) => {
 if (!isRecord(inspected)) fail('Image inspection returned an invalid record');
 const configDigest = imageIdFromInspect(inspected);
 const labels = inspected.Config?.Labels || inspected.Labels || {};
 if (!isRecord(labels)) fail('Image inspection returned invalid OCI labels');
 if (labels['org.opencontainers.image.revision'] !== expectedRevision) {
  fail(`Image revision label does not match EXPECTED_REVISION (${expectedRevision})`);
 }
 const architecture = String(inspected.Architecture || inspected.Config?.Architecture || '').toLowerCase();
 const os = String(inspected.Os || inspected.OS || inspected.Config?.Os || '').toLowerCase();
 if (os !== 'linux' || !['amd64', 'x86_64'].includes(architecture)) {
  fail(`Only linux/amd64 images are accepted (got ${os || 'unknown'}/${architecture || 'unknown'})`);
 }
 return {
  image,
  engine,
  configDigest,
  imageId: configDigest,
  expectedRevision,
  architecture: architecture === 'x86_64' ? 'amd64' : architecture,
  os,
  created: inspected.Created || null,
  sizeBytes: Number.isSafeInteger(inspected.Size) ? inspected.Size : null,
  repoTags: Array.isArray(inspected.RepoTags) ? inspected.RepoTags : [],
  repoDigests: Array.isArray(inspected.RepoDigests) ? inspected.RepoDigests : [],
  rootfsLayers: Array.isArray(inspected.RootFS?.Layers) ? inspected.RootFS.Layers : [],
  baseImagePins: Object.fromEntries(Object.entries(labels).filter(([key]) => /^org\.opencontainers\.image\.base\./.test(key))),
  labels: {
   'org.opencontainers.image.revision': labels['org.opencontainers.image.revision'],
   'org.opencontainers.image.version': labels['org.opencontainers.image.version'] || null,
   'org.opencontainers.image.source': labels['org.opencontainers.image.source'] || null,
  },
 };
};

const inspectImage = async (engine, image) => {
 const { stdout } = await run(engine, ['image', 'inspect', image], { encoding: 'utf8' });
 let records;
 try { records = JSON.parse(stdout); } catch (error) { throw new Error('Container engine returned invalid image inspection JSON', { cause: error }); }
 if (!Array.isArray(records) || records.length !== 1) fail('Container engine did not inspect exactly one image');
 return records[0];
};

const locateTrivy = async () => {
 const candidates = [];
 if (nonEmptyString(process.env.TRIVY_BIN)) candidates.push(resolve(process.env.TRIVY_BIN));
 candidates.push('trivy');
 for (const candidate of candidates) {
  try {
   if (candidate !== 'trivy') await access(candidate);
   return candidate;
  } catch { /* Try the next pinned location. */ }
 }
 fail('Pinned Trivy 0.74.0 was not found; set TRIVY_BIN or install the qualification tool');
};
const trivyEnvironment = () => {
 const allowed = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'CURL_CA_BUNDLE',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
 ]);
 const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key)));
 if (!environment.PATH) environment.PATH = '/usr/local/bin:/usr/bin:/bin';
 return environment;
};

const trivyPrefix = ['--config', '/dev/null'];
const trivyScanPolicyFlags = [
 '--ignorefile', '/dev/null',
 '--severity', 'UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL',
 '--ignore-unfixed=false',
 '--exit-code', '0',
];


const verifyTrivy = async trivy => {
 const { stdout } = await run(trivy, [...trivyPrefix, 'version', '--format', 'json'], { encoding: 'utf8', env: trivyEnvironment() });
 let version;
 try { version = JSON.parse(stdout); } catch (error) { throw new Error('Trivy returned invalid version JSON', { cause: error }); }
 if (version?.Version !== PINNED_TRIVY_VERSION) {
  fail(`Trivy ${PINNED_TRIVY_VERSION} is required (found ${version?.Version || 'unknown'})`);
 }
 return { name: 'trivy', version: PINNED_TRIVY_VERSION };
};

const validateDbMetadata = (metadata, observedAt = new Date()) => {
 if (!isRecord(metadata)) fail('Trivy vulnerability database metadata is missing');
 const dates = {};
 for (const field of ['UpdatedAt', 'DownloadedAt', 'NextUpdate']) {
  if (!nonEmptyString(metadata[field])) fail(`Trivy vulnerability database metadata is missing ${field}`);
  const parsed = Date.parse(metadata[field]);
  if (!Number.isFinite(parsed)) fail(`Trivy vulnerability database metadata has invalid ${field}`);
  dates[field] = parsed;
 }
 const now = observedAt.getTime();
 if (dates.DownloadedAt > now + 5 * 60 * 1000) fail('Trivy vulnerability database DownloadedAt is in the future');
 if (dates.UpdatedAt > now + 5 * 60 * 1000) fail('Trivy vulnerability database UpdatedAt is in the future');
 if (dates.NextUpdate <= now) fail(`Trivy vulnerability database expired at ${metadata.NextUpdate}`);
 return {
  version: metadata.Version ?? null,
  updatedAt: metadata.UpdatedAt,
  downloadedAt: metadata.DownloadedAt,
  nextUpdate: metadata.NextUpdate,
  observedAt: observedAt.toISOString(),
  fresh: true,
 };
};

const osFamily = value => {
 if (typeof value === 'string') return value.toLowerCase();
 if (isRecord(value) && nonEmptyString(value.Family)) return value.Family.toLowerCase();
 return '';
};

const packageName = pkg => pkg?.Name || pkg?.PkgName || '';
/**
 * Evaluate a complete Trivy container report without applying any suppression.
 *
 * The report must contain an Alpine OS package inventory and at least one
 * language package inventory. A finding is blocking only when it is HIGH or
 * CRITICAL and Trivy supplies a non-empty FixedVersion. Unfixed findings are
 * returned separately so callers can report them without treating them as a
 * pass or silently hiding them.
 */
export function evaluateImageReport(report) {
 if (!isRecord(report)) fail('Trivy report must be a JSON object');
 if (report.SchemaVersion !== 2) fail('Unsupported or missing Trivy report SchemaVersion');
 if (report.ArtifactType !== 'container_image') fail('Trivy report is not a container image report');
 if (!nonEmptyString(report.ArtifactName)) fail('Trivy report is missing ArtifactName');
 if (!isRecord(report.Metadata)) fail('Trivy report is missing Metadata');
 if (!digest(report.Metadata.ImageID)) fail('Trivy report is missing immutable Metadata.ImageID');
 if (!osFamily(report.Metadata.OS)) fail('Trivy report is missing recognized Metadata.OS');
 if (osFamily(report.Metadata.OS) !== 'alpine') fail('Trivy report does not contain the required Alpine inventory');
 const architecture = report.Metadata.Architecture || report.Metadata.ImageConfig?.architecture;
 if (!nonEmptyString(architecture) || !['amd64', 'x86_64'].includes(String(architecture).toLowerCase())) {
  fail('Trivy report is missing supported amd64 architecture inventory');
 }
 if (!Array.isArray(report.Results) || report.Results.length === 0) fail('Trivy report has no scan results');

 const osResults = report.Results.filter(result => isRecord(result)
  && result.Class === 'os-pkgs'
  && String(result.Type || '').toLowerCase() === 'alpine');
 if (osResults.length === 0) fail('Trivy report has no Alpine os-pkgs result');
 for (const result of osResults) validatePackageInventory(result, 'Alpine OS');

 const languageCandidates = report.Results.filter(result => isRecord(result) && result.Class === 'lang-pkgs');
 const languageResults = languageCandidates.filter(result => SUPPORTED_RUNTIME_TYPES.has(String(result.Type || '').toLowerCase()));
 if (languageResults.length === 0) fail('Trivy report has no supported language package result');
 for (const result of languageResults) validatePackageInventory(result, 'language');

 const blocking = [];
 const unfixed = [];
 for (const result of report.Results) {
  if (!isRecord(result)) fail('Trivy report contains an invalid result');
  const vulnerabilities = result.Vulnerabilities == null ? [] : result.Vulnerabilities;
  if (!Array.isArray(vulnerabilities)) fail('Trivy result Vulnerabilities must be an array or null');
  for (const vulnerability of vulnerabilities) {
   validateVulnerability(vulnerability);
   const severity = vulnerability.Severity.toUpperCase();
   if (!HIGH_IMPACT.has(severity)) continue;
   const fixed = nonEmptyString(vulnerability.FixedVersion);
   if (fixed) blocking.push(vulnerability);
   else unfixed.push(vulnerability);
  }
 }
 return { blocking, unfixed };
}

function validatePackageInventory(result, label) {
 if (!Array.isArray(result.Packages) || result.Packages.length === 0) fail(`Trivy report has no ${label} package inventory`);
 for (const pkg of result.Packages) {
  if (!isRecord(pkg) || !nonEmptyString(packageName(pkg)) || !nonEmptyString(pkg.Version)) {
   fail(`Trivy report has an incomplete ${label} package inventory`);
  }
 }
}

function validateVulnerability(vulnerability) {
 if (!isRecord(vulnerability)) fail('Trivy report contains an invalid vulnerability');
 if (!nonEmptyString(vulnerability.VulnerabilityID)) fail('Trivy vulnerability is missing VulnerabilityID');
 if (!nonEmptyString(vulnerability.PkgName || vulnerability.PkgID)) fail('Trivy vulnerability is missing package name');
 if (!nonEmptyString(vulnerability.InstalledVersion)) fail('Trivy vulnerability is missing InstalledVersion');
 if (!nonEmptyString(vulnerability.Severity) || !SEVERITIES.has(vulnerability.Severity.toUpperCase())) {
  fail('Trivy vulnerability has an unrecognized Severity');
 }
 if (vulnerability.FixedVersion != null && typeof vulnerability.FixedVersion !== 'string') {
  fail('Trivy vulnerability FixedVersion must be a string or null');
 }
}

const findingSummary = vulnerability => ({
 id: vulnerability.VulnerabilityID,
 package: vulnerability.PkgName || vulnerability.PkgID,
 installedVersion: vulnerability.InstalledVersion,
 fixedVersion: nonEmptyString(vulnerability.FixedVersion) ? vulnerability.FixedVersion : null,
 severity: vulnerability.Severity.toUpperCase(),
 status: nonEmptyString(vulnerability.FixedVersion) ? 'fixable' : 'unfixed',
});

const createArchive = async (engine, image, directory, identity) => {
 const archive = join(directory, 'image.docker.tar');
 const saveArgs = engine === 'podman'
  ? ['save', '--format', 'docker-archive', '--output', archive, image]
  : ['save', '--output', archive, image];
 await run(engine, saveArgs, { encoding: 'utf8' });
 const archiveStat = await stat(archive);
 if (!archiveStat.isFile() || archiveStat.size === 0) fail('Container engine produced an empty image archive');
 const archiveSha256 = await hashFile(archive);
 let manifest;
 try {
  const { stdout } = await run('tar', ['-xOf', archive, 'manifest.json'], { encoding: 'utf8' });
  manifest = JSON.parse(stdout);
 } catch (error) { throw new Error('Image export is not a valid Docker archive', { cause: error }); }
 if (!Array.isArray(manifest) || manifest.length === 0 || manifest.some(entry => !isRecord(entry) || !nonEmptyString(entry.Config))) {
  fail('Docker archive has no immutable config entry');
 }
 const configNames = new Set(manifest.map(entry => entry.Config));
 if (configNames.size !== 1) fail('Docker archive contains multiple image configs');
 const configName = manifest[0].Config;
 const configBytes = (await run('tar', ['-xOf', archive, configName], { encoding: null })).stdout;
 const configHash = createHash('sha256').update(configBytes).digest('hex');
 if (configHash !== identity.configDigest.slice('sha256:'.length)) {
  fail(`Docker archive config digest ${configHash} does not match inspected image ${identity.configDigest}`);
 }
 return {
  path: archive,
  sha256: archiveSha256,
  bytes: archiveStat.size,
  configPath: configName,
  configDigest: identity.configDigest,
  format: 'docker-archive',
 };
};

const readDbMetadata = async (cacheDirectory, observedAt) => {
 const path = join(cacheDirectory, 'db', 'metadata.json');
 let parsed;
 try { parsed = JSON.parse(await readFile(path, 'utf8')); }
 catch (error) { throw new Error('Trivy did not produce readable vulnerability database metadata', { cause: error }); }
 return validateDbMetadata(parsed, observedAt);
};

const ensureReportIdentity = (report, identity) => {
 if (digest(report.Metadata?.ImageID) !== identity.configDigest) {
  fail(`Trivy scanned config ${report.Metadata?.ImageID || 'unknown'}, expected ${identity.configDigest}`);
 }
};

const baseSummary = (image, reportDirectory, engine, expectedRevision) => ({
 schemaVersion: 1,
 status: 'error',
 image,
 reportDirectory,
 containerEngine: engine,
 expectedRevision,
 startedAt: new Date().toISOString(),
 scanner: { name: 'trivy', requiredVersion: PINNED_TRIVY_VERSION },
 artifacts: {
  identity: 'image-identity.json',
  report: 'trivy-report.json',
  sbom: 'sbom.cdx.json',
  database: 'db-metadata.json',
  summary: 'summary.json',
 },
});

async function main() {
 const [image, reportDirectoryArgument] = process.argv.slice(2);
 const engine = process.env.CONTAINER_ENGINE || 'docker';
 const expectedRevision = process.env.EXPECTED_REVISION;
 if (!image || image.startsWith('-') || !reportDirectoryArgument || process.argv.length !== 4) {
  throw new Error('Usage: node scripts/scan-image.mjs <image> <report-directory>');
 }
 if (!['docker', 'podman'].includes(engine)) throw new Error('CONTAINER_ENGINE must be docker or podman');
 if (!nonEmptyString(expectedRevision) || expectedRevision.startsWith('-')) throw new Error('EXPECTED_REVISION is required');
 const reportDirectory = resolve(reportDirectoryArgument);
 await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
 const summary = baseSummary(image, reportDirectory, engine, expectedRevision);
 let temporary;
 try {
  const trivy = await locateTrivy();
  summary.scanner = { ...summary.scanner, ...(await verifyTrivy(trivy)), binary: trivy };
  summary.trivyVersion = summary.scanner.version;
  const firstInspection = await inspectImage(engine, image);
  const identity = inspectIdentity(firstInspection, image, expectedRevision, engine);
  summary.identity = identity;
  summary.imageConfigDigest = identity.configDigest;
  summary.imageId = identity.imageId;
  summary.imageRevision = identity.expectedRevision;
  summary.imageSizeBytes = identity.sizeBytes;
  summary.baseImagePins = identity.baseImagePins;
  await writeJson(join(reportDirectory, 'image-identity.json'), identity);

  temporary = await mkdtemp(join(reportDirectory, '.scan-'));
  const archive = await createArchive(engine, image, temporary, identity);
  summary.identity.archive = { ...archive, path: 'temporary image export (not retained)' };
  const secondInspection = inspectIdentity(await inspectImage(engine, image), image, expectedRevision, engine);
  if (secondInspection.configDigest !== identity.configDigest) fail('Image tag changed while creating its immutable archive');
  await writeJson(join(reportDirectory, 'image-identity.json'), summary.identity);

  const cacheDirectory = join(temporary, 'trivy-cache');
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  const refreshStartedAt = new Date();
  await run(trivy, [...trivyPrefix, 'image', ...trivyScanPolicyFlags, '--download-db-only', '--cache-dir', cacheDirectory, '--no-progress'], { encoding: 'utf8', env: trivyEnvironment() });
  const database = await readDbMetadata(cacheDirectory, new Date());
  summary.database = { ...database, refreshStartedAt: refreshStartedAt.toISOString() };
  summary.dbUpdatedAt = database.updatedAt;
  summary.dbDownloadedAt = database.downloadedAt;
  summary.dbNextUpdate = database.nextUpdate;
  await writeJson(join(reportDirectory, 'db-metadata.json'), summary.database);

  const trivyReportPath = join(reportDirectory, 'trivy-report.json');
  await run(trivy, [
   ...trivyPrefix, 'image', ...trivyScanPolicyFlags,
   '--input', archive.path, '--cache-dir', cacheDirectory,
   '--scanners', 'vuln', '--list-all-pkgs', '--skip-db-update', '--no-progress',
   '--format', 'json', '--output', trivyReportPath,
  ], { encoding: 'utf8', env: trivyEnvironment() });
  const report = JSON.parse(await readFile(trivyReportPath, 'utf8'));
  ensureReportIdentity(report, identity);
  const policy = evaluateImageReport(report);
  summary.policy = {
   blockingCount: policy.blocking.length,
   unfixedCount: policy.unfixed.length,
   blocking: policy.blocking.map(findingSummary),
   unfixed: policy.unfixed.map(findingSummary),
  };
  summary.findings = {
   blockingCount: policy.blocking.length,
   fixedHighCriticalCount: policy.blocking.length,
   unfixedCount: policy.unfixed.length,
   unfixedHighCriticalCount: policy.unfixed.length,
   totalHighCritical: policy.blocking.length + policy.unfixed.length,
  };

  const sbomPath = join(reportDirectory, 'sbom.cdx.json');
  await run(trivy, [
   ...trivyPrefix, 'image', ...trivyScanPolicyFlags,
   '--input', archive.path, '--cache-dir', cacheDirectory,
   '--skip-db-update', '--no-progress', '--format', 'cyclonedx', '--output', sbomPath,
  ], { encoding: 'utf8', env: trivyEnvironment() });
  const sbom = JSON.parse(await readFile(sbomPath, 'utf8'));
  if (!isRecord(sbom) || sbom.bomFormat !== 'CycloneDX') fail('Trivy produced an invalid CycloneDX SBOM');
  summary.sbom = {
   format: 'CycloneDX',
   specVersion: sbom.specVersion || null,
   serialNumber: sbom.serialNumber || null,
   components: Array.isArray(sbom.components) ? sbom.components.length : 0,
  };
  if (summary.sbom.components === 0) fail('Trivy produced an empty CycloneDX SBOM');

  summary.status = policy.blocking.length > 0 ? 'policy-failed' : 'passed';
  summary.finishedAt = new Date().toISOString();
  summary.scanTimeUtc = summary.finishedAt;
  await writeJson(join(reportDirectory, 'summary.json'), summary);
  if (policy.unfixed.length > 0) {
   console.warn(`Unfixed HIGH/CRITICAL findings (${policy.unfixed.length}):`);
   for (const finding of policy.unfixed.map(findingSummary)) console.warn(`- ${finding.id} ${finding.package}@${finding.installedVersion} ${finding.status}`);
  }
  if (policy.blocking.length > 0) {
   console.error(`Image policy failed: ${policy.blocking.length} fixable HIGH/CRITICAL finding(s)`);
   for (const finding of policy.blocking.map(findingSummary)) console.error(`- ${finding.id} ${finding.package}@${finding.installedVersion} fixed by ${finding.fixedVersion}`);
   process.exitCode = 1;
  } else {
   console.log(`Image scan passed: ${identity.configDigest}, ${policy.unfixed.length} unfixed HIGH/CRITICAL finding(s), ${summary.sbom.components} SBOM components`);
  }
 } catch (error) {
  summary.error = redact(error.message);
  summary.finishedAt = new Date().toISOString();
  summary.scanTimeUtc = summary.finishedAt;
  await writeJson(join(reportDirectory, 'error.json'), { error: summary.error, finishedAt: summary.finishedAt }).catch(() => { });
  await writeJson(join(reportDirectory, 'summary.json'), summary).catch(() => { });
  console.error(summary.error);
  process.exitCode = 1;
 } finally {
  if (temporary) await rm(temporary, { recursive: true, force: true });
 }
}

const invokedPath = process.argv[1] && resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) await main();
