import { AuthError, beginLogin, completeLogin, logout } from '../server/auth.server';

const secureHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'" };
const jsonError = (error: unknown): Response => {
  const status = error instanceof AuthError ? error.status : 500;
  const code = error instanceof AuthError ? error.code : 'internal_error';
  const message = error instanceof AuthError ? error.message : 'Authentication could not be completed';
  return new Response(JSON.stringify({ error: message, code }), { status, headers: secureHeaders });
};

export async function loader({ request }: { request: Request }): Promise<Response> {
  try {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/auth/login') return await beginLogin(request);
    if (pathname === '/auth/callback') return await completeLogin(request);
    return new Response(JSON.stringify({ error: 'Not found', code: 'not_found' }), { status: 404, headers: secureHeaders });
  } catch (error) { return jsonError(error); }
}

export async function action({ request }: { request: Request }): Promise<Response> {
  try {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/auth/logout' && request.method === 'POST') {
      return await logout(request);
    }
    return new Response(JSON.stringify({ error: 'Not found', code: 'not_found' }), { status: 404, headers: secureHeaders });
  } catch (error) { return jsonError(error); }
}
