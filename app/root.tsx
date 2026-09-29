import type { ReactNode } from 'react';
import { data, Links, Meta, Outlet, Scripts, ScrollRestoration, isRouteErrorResponse, useRouteError, useRouteLoaderData } from 'react-router';
import { randomBytes } from 'node:crypto';
import './work.css';
import { Button } from './components/ui/button';

export function loader() {
  const nonce = randomBytes(24).toString('base64');
  const scriptPolicy = process.env.NODE_ENV === 'production' ? `'nonce-${nonce}' 'strict-dynamic'` : "'self' 'unsafe-inline'";
  return data({ nonce }, {
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'self'; script-src ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'${process.env.NODE_ENV === 'production' ? '' : ' ws: wss:'}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'`,
    }
  });
}
export function headers({ loaderHeaders }: { loaderHeaders: Headers }) { return loaderHeaders; }
export function meta() { return [{ title: 'Goalie — shared team work' }, { name: 'description', content: 'Shared goals, workstreams, tasks, ownership, and updates.' }]; }
export function links() {
  return [
    { rel: 'manifest', href: '/manifest.webmanifest' },
    { rel: 'icon', type: 'image/svg+xml', href: '/icons/goalie.svg' },
  ];
}

export function Layout({ children }: { children: ReactNode }) {
  const root = useRouteLoaderData<typeof loader>('root');
  return <html lang="en" suppressHydrationWarning><head><meta charSet="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" /><script nonce={root?.nonce} dangerouslySetInnerHTML={{ __html: `(()=>{try{const value=localStorage.getItem('goalie-theme');const preference=value==='dark'||value==='light'||value==='system'?value:'system';const dark=preference==='dark'||(preference==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);document.documentElement.dataset.theme=dark?'dark':'light';document.documentElement.dataset.themePreference=preference;document.documentElement.style.colorScheme=dark?'dark':'light'}catch{}})()` }} /><Meta /><Links /></head><body>{children}<ScrollRestoration nonce={root?.nonce} /><Scripts nonce={root?.nonce} /></body></html>;
}
export default function App() { return <Outlet />; }

export function ErrorBoundary() {
  const error = useRouteError();
  const message = isRouteErrorResponse(error) ? `${error.status}: ${error.statusText}` : 'The application could not load. Check the server logs or try again.';
  return <main className="error-screen"><div className="error-card"><h1>We hit an unexpected error</h1><p>{message}</p><Button asChild><a href="/">Return to register</a></Button></div></main>;
}

