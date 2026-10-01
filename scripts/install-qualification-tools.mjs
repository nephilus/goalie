import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const directory = process.argv[2] && resolve(process.argv[2]);
assert(directory && process.platform === 'linux' && process.arch === 'x64', 'Usage: node scripts/install-qualification-tools.mjs <private-directory> [helm kind kubectl trivy]; Linux amd64 only');
const specs = {
  helm: { version: '4.3.0', url: 'https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz', checksum: 'https://get.helm.sh/helm-v4.3.0-linux-amd64.tar.gz.sha256sum', member: 'linux-amd64/helm' },
  kind: { version: '0.31.0', url: 'https://github.com/kubernetes-sigs/kind/releases/download/v0.31.0/kind-linux-amd64', checksum: 'https://github.com/kubernetes-sigs/kind/releases/download/v0.31.0/kind-linux-amd64.sha256sum' },
  kubectl: { version: '1.35.0', url: 'https://dl.k8s.io/release/v1.35.0/bin/linux/amd64/kubectl', checksum: 'https://dl.k8s.io/release/v1.35.0/bin/linux/amd64/kubectl.sha256' },
  trivy: { version: '0.74.0', url: 'https://github.com/aquasecurity/trivy/releases/download/v0.74.0/trivy_0.74.0_Linux-64bit.tar.gz', checksum: 'https://github.com/aquasecurity/trivy/releases/download/v0.74.0/trivy_0.74.0_checksums.txt', member: 'trivy' },
};
const selected = process.argv.slice(3);
const names = selected.length ? selected : Object.keys(specs);
assert(names.every(name => Object.hasOwn(specs, name)) && new Set(names).size === names.length, 'Unknown or duplicate qualification tool');
const download = async url => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    assert(response.ok, `HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (error) {
    throw new Error(`Download failed for ${url}: ${error.message}`, { cause: error });
  }
};
await mkdir(directory, { recursive: true, mode: 0o700 });
const temporary = await mkdtemp(join(directory, '.download-'));
try {
  const evidence = {};
  for (const name of names) {
    const spec = specs[name];
    const filename = new URL(spec.url).pathname.split('/').pop();
    const checksums = (await download(spec.checksum)).toString('utf8').trim().split(/\r?\n/);
    const line = checksums.find(line => line.trim().split(/\s+/).slice(1).some(value => value.replace(/^\*/, '') === filename)) || (checksums.length === 1 ? checksums[0] : '');
    const expected = line.trim().split(/\s+/)[0];
    assert(/^[a-f0-9]{64}$/.test(expected), `No published checksum for ${name}`);
    const bytes = await download(spec.url);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, `${name} checksum mismatch`);
    const archive = join(temporary, filename);
    await writeFile(archive, bytes, { mode: 0o600 });
    let executable = archive;
    if (spec.member) {
      execFileSync('tar', ['-xzf', archive, '-C', temporary, spec.member], { timeout: 30_000, stdio: 'pipe' });
      executable = join(temporary, spec.member);
    }
    await chmod(executable, 0o755);
    await rename(executable, join(directory, name));
    evidence[name] = { version: spec.version, url: spec.url, archiveSha256: expected, binarySha256: createHash('sha256').update(await readFile(join(directory, name))).digest('hex') };
    console.log(`Installed checksum-verified ${name} ${spec.version}`);
  }
  await writeFile(join(directory, 'qualification-tools.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
} finally { await rm(temporary, { recursive: true, force: true }); }
