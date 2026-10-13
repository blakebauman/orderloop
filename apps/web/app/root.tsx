import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import type { Route } from './+types/root';
import './app.css';

export const links: Route.LinksFunction = () => [
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
  { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossOrigin: 'anonymous' },
  {
    rel: 'stylesheet',
    href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
  },
];

export const meta: Route.MetaFunction = () => [{ title: 'Order Loop' }];

/**
 * Resolves the stored theme choice ("light" by default, "dark", or "system") to `data-theme` before
 * first paint, and follows the OS while "system" is chosen. Kept tiny and inline on purpose.
 */
const THEME_SCRIPT = `(function(){var d=document.documentElement,m=window.matchMedia('(prefers-color-scheme: dark)');function a(){var c='light';try{c=localStorage.getItem('ol-theme')||'light'}catch(e){c=d.dataset.themeChoice||'light'}d.dataset.themeChoice=c;d.dataset.theme=c==='system'?(m.matches?'dark':'light'):c}a();m.addEventListener('change',a);window.addEventListener('ol-theme',a)})()`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = 'Something went wrong';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? 'Not found' : `Error ${error.status}`;
    details = error.status === 404 ? 'That page does not exist.' : error.statusText || details;
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }
  return (
    <main className="mx-auto max-w-2xl px-6 py-24">
      <h1 className="tracking-title font-semibold text-3xl">{title}</h1>
      <p className="mt-2 text-muted-foreground">{details}</p>
      {stack && <pre className="mt-6 overflow-x-auto rounded-lg bg-muted p-4 text-xs">{stack}</pre>}
      <a href="/" className="mt-8 inline-block font-medium text-link text-sm hover:underline">
        Back to the overview
      </a>
    </main>
  );
}
