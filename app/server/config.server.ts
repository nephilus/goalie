import { readFileSync } from 'node:fs';

export type AppConfig = {
  databaseUrl: string;
  appUrl: URL;
  oidcIssuer: URL;
  oidcClientId: string;
  oidcClientSecret: string;
  authBootstrapEmail: string | null;
  nodeEnv: string;
  dbCa: string | undefined;
  maxBodyBytes: number;
};

const normalizeEmail = (value: string) => value.trim().toLowerCase();

export function getConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV ?? 'development';
  const databaseUrl = env.DATABASE_URL?.trim();
  const appUrlText = env.APP_URL?.trim();
  const issuerText = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET ?? '';
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  if (!appUrlText) throw new Error('APP_URL is required');
  if (!issuerText) throw new Error('OIDC_ISSUER is required');
  if (!clientId) throw new Error('OIDC_CLIENT_ID is required');
  if (!clientSecret) throw new Error('OIDC_CLIENT_SECRET is required');
  let appUrl: URL;
  let oidcIssuer: URL;
  try { appUrl = new URL(appUrlText); } catch { throw new Error('APP_URL must be an absolute URL'); }
  try { oidcIssuer = new URL(issuerText); } catch { throw new Error('OIDC_ISSUER must be an absolute URL'); }
  if (!['http:', 'https:'].includes(appUrl.protocol)) throw new Error('APP_URL must use HTTP(S)');
  if (!['http:', 'https:'].includes(oidcIssuer.protocol)) throw new Error('OIDC_ISSUER must use HTTP(S)');
  if (appUrl.username || appUrl.password || appUrl.search || appUrl.hash || appUrl.pathname !== '/') throw new Error('APP_URL must be an origin without credentials, query, fragment, or subpath');
  if (oidcIssuer.username || oidcIssuer.password || oidcIssuer.search || oidcIssuer.hash) throw new Error('OIDC_ISSUER must not contain credentials, query, or fragment');
  if (nodeEnv === 'production' && appUrl.protocol !== 'https:') throw new Error('APP_URL must use HTTPS in production');
  if (nodeEnv === 'production' && oidcIssuer.protocol !== 'https:') throw new Error('OIDC_ISSUER must use HTTPS in production');
  const loopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(oidcIssuer.hostname);
  const localDex = loopback && Boolean(oidcIssuer.port) && (oidcIssuer.pathname === '/dex' || oidcIssuer.pathname === '/dex/');
  if (oidcIssuer.protocol === 'http:' && !localDex) throw new Error('HTTP OIDC_ISSUER is permitted only for loopback Dex with an explicit port');
  if (localDex && nodeEnv === 'production') throw new Error('Local Dex is not permitted in production');
  let dbCa: string | undefined;
  if (env.DB_CA_FILE?.trim()) {
    try { dbCa = readFileSync(env.DB_CA_FILE.trim(), 'utf8'); } catch { throw new Error('DB_CA_FILE could not be read'); }
  }
  const maxBodyBytes = Number(env.MAX_REQUEST_BODY_BYTES ?? 2_000_000);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1_024 || maxBodyBytes > 20_000_000) throw new Error('MAX_REQUEST_BODY_BYTES must be between 1024 and 20000000');
  return { databaseUrl, appUrl, oidcIssuer, oidcClientId: clientId, oidcClientSecret: clientSecret, authBootstrapEmail: env.AUTH_BOOTSTRAP_EMAIL?.trim() ? normalizeEmail(env.AUTH_BOOTSTRAP_EMAIL) : null, nodeEnv, dbCa, maxBodyBytes };
}

export const sameOrigin = (request: Request, config = getConfig()): boolean => {
  return request.headers.get('origin') === config.appUrl.origin;
};

export const isSecureRequest = (request: Request, config = getConfig()): boolean => config.appUrl.protocol === 'https:' || new URL(request.url).protocol === 'https:';
