import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const [source, ...targets] = process.argv.slice(2);
assert(targets.length > 0 && source && !source.startsWith('-'), 'Usage: node scripts/publish-image.mjs <tested-image> <repository:X.Y.Z> [...]');
assert(targets.every(target => /^[a-z0-9][a-z0-9._:/-]*:(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(target)), 'Targets must be lowercase repositories with exact X.Y.Z tags');

const docker = args => exec('docker', args, { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
const inspect = async image => JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
const imageId = image => image.Id.startsWith('sha256:') ? image.Id : `sha256:${image.Id}`;
const report = async text => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `- ${text}\n`);
};
const diagnostics = error => String(error.stderr || error.message)
  .replace(/(password|token|authorization|secret)([=:][^\s]+)/gi, '$1=[REDACTED]')
  .replace(/https?:\/\/[^\s@]+@/g, 'https://[REDACTED]@');

try {
  // Capture identity before pulling: a remote tag must never replace our source reference.
  const expected = imageId(await inspect(source));
  const missing = [];
  // Inspect every registry before any writes: a rebuilt artifact must not split a version
  // across registries when one already contains the original image.
  for (const target of targets) {
    let exists = true;
    try {
      await docker(['pull', '--platform', 'linux/amd64', target]);
    } catch (error) {
      // Only an explicit registry absence permits a write. Auth/network failures are not absence.
      if (/\b(?:manifest unknown|name unknown)\b/i.test(String(error.stderr))) exists = false;
      else throw error;
    }
    if (exists) {
      const remote = await inspect(target);
      if (imageId(remote) !== expected) throw new Error(`Immutable tag conflict: ${target} does not contain the tested image; no targets will be written`);
      await report(`${target}: already published; matching config digest ${expected}`);
    } else {
      missing.push(target);
    }
  }
  for (const target of missing) {
    let pushed = false;
    try {
      await docker(['tag', expected, target]);
      await docker(['push', target]);
      pushed = true;
      await docker(['pull', '--platform', 'linux/amd64', target]);
      const remote = await inspect(target);
      if (imageId(remote) !== expected) throw new Error(`Published image identity mismatch for ${target}`);
      await report(`${target}: published; config digest ${expected}`);
    } catch (error) {
      console.error(diagnostics(error));
      await report(`${target}: ${pushed ? 'pushed but verification failed; tag retained' : 'publication failed; no tags deleted'}`);
      process.exitCode = 1;
    }
  }
} catch (error) {
  console.error(diagnostics(error));
  await report('Publication stopped; any successful publications are retained');
  process.exitCode = 1;
}
