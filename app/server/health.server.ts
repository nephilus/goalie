import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const migrationDirectory = join(process.cwd(), 'migrations');
const expected = readdirSync(migrationDirectory).filter(file => /^\d+_.+\.sql$/.test(file)).sort().map(file => ({
  version: file.slice(0, file.indexOf('_')),
  checksum: createHash('sha256').update(readFileSync(join(migrationDirectory, file), 'utf8')).digest('hex'),
}));
if (expected.length === 0) throw new Error('Bundled migrations are required');
export const expectedMigrationChecksumsJson = JSON.stringify(expected);
