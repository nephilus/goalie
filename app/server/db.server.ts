import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { createHash } from 'node:crypto';

const env = process.env;
const ca = env.DB_CA_FILE?.trim() ? readFileSync(env.DB_CA_FILE.trim(), 'utf8') : undefined;
if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const databaseUrl = new URL(env.DATABASE_URL);
if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
const verifiedTls = env.NODE_ENV === 'production' || Boolean(ca);
if (verifiedTls) {
  if (databaseUrl.searchParams.has('sslmode') && databaseUrl.searchParams.get('sslmode') !== 'verify-full') throw new Error('Verified database TLS requires sslmode=verify-full or no sslmode parameter');
  // pg otherwise lets URI SSL parameters override the explicit CA and verification settings.
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) databaseUrl.searchParams.delete(key);
}
const maxConnections = Number(env.DB_POOL_MAX ?? 10);
if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 100) throw new Error('DB_POOL_MAX must be between 1 and 100');
export const pool = new Pool({
  connectionString: databaseUrl.toString(),
  max: maxConnections,
  ssl: verifiedTls ? { ca, rejectUnauthorized: true } : undefined,
  application_name: 'goalie',
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
});

export async function withTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function migrate(): Promise<void> {
  const migrationDirectory = join(process.cwd(), 'migrations');
  const files = readdirSync(migrationDirectory).filter(file => /^\d+_.+\.sql$/.test(file)).sort();
  await withTransaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock(716492001)');
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, checksum text, applied_at timestamptz NOT NULL DEFAULT now())');
    await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text');
    for (const file of files) {
      const version = file.slice(0, file.indexOf('_'));
      const sql = readFileSync(join(migrationDirectory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const applied = (await client.query<{ checksum: string | null }>('SELECT checksum FROM schema_migrations WHERE version = $1', [version])).rows[0];
      if (applied) {
        if (applied.checksum && applied.checksum !== checksum) throw new Error(`Applied migration ${version} has changed`);
        if (!applied.checksum) await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2', [checksum, version]);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version, checksum) VALUES($1, $2)', [version, checksum]);
    }
  });
}
