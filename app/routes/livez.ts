const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' };

export function loader({ request }: { request: Request }): Response {
  if (request.method !== 'GET') return new Response(JSON.stringify({ error: 'Method not allowed', code: 'method_not_allowed' }), { status: 405, headers: { ...headers, Allow: 'GET' } });
  return new Response(JSON.stringify({ status: 'alive' }), { headers });
}

export const action = loader;
