import { expectedMigrationChecksumsJson } from '../server/health.server';
import { pool } from '../server/db.server';

const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };

export async function loader({ request }: { request: Request }): Promise<Response> {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed', code: 'method_not_allowed' }), { status: 405, headers: { ...headers, Allow: 'GET' } });
  try {
    const initialized = await pool.query(
      `SELECT revision FROM simple_workspace WHERE id = 1 AND NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS required(version text, checksum text)
        LEFT JOIN schema_migrations applied ON applied.version = required.version
        WHERE applied.checksum IS DISTINCT FROM required.checksum
      )`,
      [expectedMigrationChecksumsJson],
    );
    return new Response(JSON.stringify({ status: initialized.rowCount === 1 ? 'ready' : 'error' }), { status: initialized.rowCount === 1 ? 200 : 503, headers });
  } catch {
    return new Response(JSON.stringify({ status: 'error' }), { status: 503, headers });
  }
}

export const action = loader;
