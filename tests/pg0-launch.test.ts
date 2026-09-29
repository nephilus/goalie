import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('missing pg0 is diagnosable without printing database credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'goalie-launch-'));
  const secret = 'never-print-this-synthetic-password';
  try {
    await writeFile(join(directory, '.env'), `DATABASE_URL=postgres://goalie:${secret}@127.0.0.1:54339/goalie\n`, { mode: 0o600 });
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/pg0.ts', '--instance-dir', directory], { encoding: 'utf8', env: { ...process.env, PATH: '' }, timeout: 10000 });
    const output = `${result.stdout}${result.stderr}`;
    assert.notEqual(result.status, 0);
    assert.match(output, /Could not start pg0 \(ENOENT\)/);
    assert(!output.includes(secret));
    assert(!output.includes('spawnargs'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
