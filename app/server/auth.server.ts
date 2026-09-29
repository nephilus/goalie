import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  allowInsecureRequests, authorizationCodeGrant, buildAuthorizationUrl, calculatePKCECodeChallenge, discovery,
  randomNonce, randomPKCECodeVerifier, randomState, ClientSecretPost, enableNonRepudiationChecks,
} from 'openid-client';
import type { Configuration } from 'openid-client';
import type { Person } from '../shared/model';
import { getConfig, sameOrigin } from './config.server';
import { pool, withTransaction } from './db.server';

let cookieScope: { origin: string; session: string; csrf: string; login: string } | undefined;
function cookieNames(origin = getConfig().appUrl.origin) {
  if (!cookieScope || cookieScope.origin !== origin) {
    // Cookies are host-scoped, not port-scoped. Keep co-hosted deployments independent.
    const scope = createHash('sha256').update(origin).digest('hex').slice(0, 16);
    cookieScope = { origin, session: `goalie_${scope}_session`, csrf: `goalie_${scope}_csrf`, login: `goalie_${scope}_login` };
  }
  return cookieScope;
}
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const securityHeaders: Record<string, string> = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
};
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const safeEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const cookieValue = (request: Request, name: string): string | null => {
  const cookie = request.headers.get('cookie') ?? '';
  const match = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`));
  try { return match ? decodeURIComponent(match.slice(name.length + 1)) : null; } catch { return null; }
};
const cookie = (name: string, value: string, options: { httpOnly?: boolean; secure: boolean; maxAge?: number }): string => {
  const flags = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (options.httpOnly) flags.push('HttpOnly');
  if (options.secure) flags.push('Secure');
  if (options.maxAge !== undefined) flags.push(`Max-Age=${options.maxAge}`);
  return flags.join('; ');
};
const expiredCookie = (name: string, secure: boolean): string => cookie(name, '', { secure, maxAge: 0 });

export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 401, code = 'unauthenticated') {
    super(message);
    this.name = 'AuthError';
    this.status = status;
    this.code = code;
  }
}

export type AuthContext = { person: Person; sessionId: string; csrfToken: string };

type OidcClient = Configuration;
let discovered: { issuer: string; client: OidcClient } | null = null;
async function oidcClient(): Promise<OidcClient> {
  const config = getConfig();
  const issuer = config.oidcIssuer.toString();
  if (discovered?.issuer === issuer) return discovered.client;
  const localDex = config.nodeEnv !== 'production'
    && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(config.oidcIssuer.hostname)
    && Boolean(config.oidcIssuer.port)
    && ['/dex', '/dex/'].includes(config.oidcIssuer.pathname);
  const options = localDex ? { execute: [allowInsecureRequests] } : undefined;
  const client = await discovery(config.oidcIssuer, config.oidcClientId, config.oidcClientSecret, ClientSecretPost(config.oidcClientSecret), options);
  enableNonRepudiationChecks(client);
  discovered = { issuer, client };
  return client;
}

export async function getAuth(request: Request): Promise<AuthContext | null> {
  const names = cookieNames();
  const rawSession = cookieValue(request, names.session);
  if (!rawSession) return null;
  const result = await pool.query<{ id_hash: string; person_id: string; csrf_hash: string; expires_at: Date; id: string; name: string; email: string; team: string; role: Person['role'] }>(
    'SELECT s.id_hash, s.person_id, s.csrf_hash, s.expires_at, p.id, p.name, p.email, p.team, p.role FROM sessions s JOIN people p ON p.id = s.person_id WHERE s.id_hash = $1', [hash(rawSession)],
  );
  const row = result.rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await pool.query('DELETE FROM sessions WHERE id_hash = $1', [hash(rawSession)]);
    return null;
  }
  const csrfToken = cookieValue(request, names.csrf) ?? '';
  return { person: { id: row.id, name: row.name, email: row.email, team: row.team, role: row.role }, sessionId: rawSession, csrfToken };
}

export async function requireAuth(request: Request): Promise<AuthContext> {
  const context = await getAuth(request);
  if (!context) throw new AuthError('Sign-in required');
  return context;
}

export async function requireCsrf(request: Request, auth: AuthContext): Promise<void> {
  const config = getConfig();
  if (!sameOrigin(request, config)) throw new AuthError('Cross-origin request rejected', 403, 'forbidden');
  const header = request.headers.get('x-csrf-token') ?? '';
  if (!auth.csrfToken || !header || !safeEqual(auth.csrfToken, header)) throw new AuthError('CSRF token rejected', 403, 'forbidden');
  const row = await pool.query<{ csrf_hash: string }>('SELECT csrf_hash FROM sessions WHERE id_hash = $1 AND expires_at > now()', [hash(auth.sessionId)]);
  if (!row.rows[0] || !safeEqual(row.rows[0].csrf_hash, hash(header))) throw new AuthError('CSRF token rejected', 403, 'forbidden');
}

export function authCookieHeaders(request: Request, sessionId: string, csrfToken: string): string[] {
  const config = getConfig();
  const secure = config.appUrl.protocol === 'https:' || new URL(request.url).protocol === 'https:';
  const names = cookieNames(config.appUrl.origin);
  return [cookie(names.session, sessionId, { httpOnly: true, secure, maxAge: Math.floor(SESSION_TTL_MS / 1000) }), cookie(names.csrf, csrfToken, { secure, maxAge: Math.floor(SESSION_TTL_MS / 1000) })];
}

export function clearAuthCookieHeaders(request: Request): string[] {
  const config = getConfig();
  const secure = config.appUrl.protocol === 'https:' || new URL(request.url).protocol === 'https:';
  const names = cookieNames(config.appUrl.origin);
  return [expiredCookie(names.session, secure), expiredCookie(names.csrf, secure)];
}

function safeReturnTo(value: string | null, base: URL): string {
  if (!value) return '/';
  try {
    const resolved = new URL(value, base);
    if (resolved.origin !== base.origin || !resolved.pathname.startsWith('/') || resolved.pathname.startsWith('//')) return '/';
    return `${resolved.pathname}${resolved.search}${resolved.hash}`;
  } catch {
    return '/';
  }
}

export async function beginLogin(request: Request): Promise<Response> {
  const config = getConfig();
  const state = randomState();
  const nonce = randomNonce();
  const codeVerifier = randomPKCECodeVerifier();
  const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get('returnTo'), config.appUrl);
  await pool.query('DELETE FROM pending_auth WHERE expires_at < now()');
  await pool.query('DELETE FROM sessions WHERE expires_at < now()');
  await pool.query('INSERT INTO pending_auth(state_hash, nonce, code_verifier, return_to, issuer, expires_at) VALUES($1, $2, $3, $4, $5, now() + interval \'10 minutes\')', [hash(state), nonce, codeVerifier, returnTo, config.oidcIssuer.toString()]);
  const client = await oidcClient();
  const redirectUri = new URL('/auth/callback', config.appUrl);
  const authorizationUrl = buildAuthorizationUrl(client, { client_id: config.oidcClientId, redirect_uri: redirectUri.toString(), response_type: 'code', scope: 'openid profile email', code_challenge: codeChallenge, code_challenge_method: 'S256', state, nonce });
  return new Response(null, { status: 302, headers: { ...securityHeaders, Location: authorizationUrl.toString(), 'Set-Cookie': cookie(cookieNames(config.appUrl.origin).login, state, { httpOnly: true, secure: config.appUrl.protocol === 'https:', maxAge: PENDING_TTL_MS / 1000 }) } });
}

function claimString(claims: Record<string, unknown>, key: string): string | null {
  const value = claims[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function completeLogin(request: Request): Promise<Response> {
  const config = getConfig();
  const url = new URL(request.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code) throw new AuthError('OIDC callback is missing state or code', 400, 'invalid_callback');
  const browserState = cookieValue(request, cookieNames(config.appUrl.origin).login);
  if (!browserState || !safeEqual(browserState, state)) throw new AuthError('OIDC login was not initiated in this browser', 400, 'invalid_callback');
  const pendingResult = await pool.query<{ state_hash: string; nonce: string; code_verifier: string; return_to: string; issuer: string }>('UPDATE pending_auth SET used_at = now() WHERE state_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING state_hash, nonce, code_verifier, return_to, issuer', [hash(state)]);
  const pending = pendingResult.rows[0];
  if (!pending || pending.issuer !== config.oidcIssuer.toString()) throw new AuthError('OIDC login state is invalid or expired', 400, 'invalid_callback');
  const client = await oidcClient();
  let claims: Record<string, unknown>;
  try {
    const callbackUrl = new URL('/auth/callback', config.appUrl);
    callbackUrl.search = url.search;
    const tokens = await authorizationCodeGrant(client, callbackUrl, { pkceCodeVerifier: pending.code_verifier, expectedState: state, expectedNonce: pending.nonce });
    const tokenClaims = tokens.claims();
    if (!tokenClaims) throw new Error('OIDC response did not include an ID token');
    claims = tokenClaims as unknown as Record<string, unknown>;
  } catch {
    throw new AuthError('OIDC authorization could not be verified', 401, 'invalid_identity');
  }
  const issuer = claimString(claims, 'iss');
  const subject = claimString(claims, 'sub');
  const email = claimString(claims, 'email')?.toLowerCase() ?? null;
  const verified = claims.email_verified === true;
  if (!issuer || issuer !== client.serverMetadata().issuer || !subject || !email || !verified) throw new AuthError('OIDC identity must provide a verified email', 403, 'unverified_identity');
  const name = claimString(claims, 'name') ?? claimString(claims, 'preferred_username') ?? email;
  const returnTo = safeReturnTo(pending.return_to, config.appUrl);
  const sessionId = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  await withTransaction(async clientTx => {
    await clientTx.query('SELECT id FROM workspace WHERE id = 1 FOR UPDATE');
    const binding = (await clientTx.query<{ person_id: string }>('SELECT person_id FROM oidc_subject_bindings WHERE issuer = $1 AND subject = $2', [issuer, subject])).rows[0];
    let personId = binding?.person_id ?? null;
    const peopleCount = Number((await clientTx.query<{ count: string }>('SELECT count(*)::text AS count FROM people')).rows[0].count);
    const personIdForBootstrap = randomUUID();
    const person = email === config.authBootstrapEmail && peopleCount === 0
      ? (await clientTx.query<{ id: string }>('INSERT INTO people(id, name, email, team, role) VALUES($1, $2, $3, \'\', \'admin\') RETURNING id', [personIdForBootstrap, name, email])).rows[0]
      : (await clientTx.query<{ id: string; name: string; email: string; team: string; role: Person['role'] }>('SELECT id, name, email, team, role FROM people WHERE lower(email) = $1', [email])).rows[0];
    if (!personId && !person) throw new AuthError('This verified email has not been provisioned', 403, 'not_invited');
    if (personId && person && person.id !== personId) throw new AuthError('OIDC identity is bound to a different person', 403, 'identity_conflict');
    personId = personId ?? person.id;
    const otherBinding = (await clientTx.query<{ issuer: string; subject: string }>('SELECT issuer, subject FROM oidc_subject_bindings WHERE person_id = $1', [personId])).rows[0];
    if (otherBinding && (!binding || otherBinding.issuer !== issuer || otherBinding.subject !== subject)) throw new AuthError('Person already has a different OIDC identity', 403, 'identity_conflict');
    if (!binding) await clientTx.query('INSERT INTO oidc_subject_bindings(id, person_id, issuer, subject) VALUES($1, $2, $3, $4)', [randomUUID(), personId, issuer, subject]);
    await clientTx.query('INSERT INTO sessions(id_hash, person_id, csrf_hash, expires_at) VALUES($1, $2, $3, now() + interval \'8 hours\')', [hash(sessionId), personId, hash(csrfToken)]);
  });
  const headers = new Headers(securityHeaders);
  headers.set('Location', new URL(returnTo, config.appUrl).toString());
  for (const value of authCookieHeaders(request, sessionId, csrfToken)) headers.append('Set-Cookie', value);
  headers.append('Set-Cookie', cookie(cookieNames(config.appUrl.origin).login, '', { httpOnly: true, secure: config.appUrl.protocol === 'https:', maxAge: 0 }));
  return new Response(null, { status: 302, headers });
}

export async function logout(request: Request): Promise<Response> {
  const auth = await requireAuth(request);
  await requireCsrf(request, auth);
  await pool.query('DELETE FROM sessions WHERE id_hash = $1', [hash(auth.sessionId)]);
  const headers = new Headers(securityHeaders);
  headers.set('Location', new URL('/', getConfig().appUrl).toString());
  for (const value of clearAuthCookieHeaders(request)) headers.append('Set-Cookie', value);
  return new Response(null, { status: 303, headers });
}

export { hash as hashSecret };
