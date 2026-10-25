import { useContext } from 'react';
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from 'react-router';
import type { Route } from './+types/root';
import { RouteAnnouncer } from './components/route-announcer';
// Inter (one variable file for every weight) and IBM Plex Mono, served from this origin (no
// render-blocking third-party stylesheet). Each file's unicode-range means a browser fetches only
// the subsets a page uses.
import '@fontsource-variable/inter/wght.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/ibm-plex-mono/600.css';
import interLatin from '@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url';
import './app.css';
import { NonceContext } from './lib/csp';

/** Running text and titles: fetched with the page rather than once the stylesheet is parsed. */
const fontPreload = (href: string) =>
  ({ rel: 'preload', href, as: 'font', type: 'font/woff2', crossOrigin: 'anonymous' }) as const;

export const links: Route.LinksFunction = () => [
  fontPreload(interLatin),
  { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' },
  { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' },
  { rel: 'manifest', href: '/manifest.webmanifest' },
];

/** Added to the Home Screen, it opens as its own app with the system status bar over the paper. */
export const meta: Route.MetaFunction = () => [
  { title: 'OrderLoop' },
  { name: 'apple-mobile-web-app-capable', content: 'yes' },
  { name: 'mobile-web-app-capable', content: 'yes' },
  { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
  { name: 'apple-mobile-web-app-title', content: 'OrderLoop' },
  { name: 'format-detection', content: 'telephone=no' },
];

/** Browser chrome colour per theme: `--paper` from app.css, in hex (the manifest needs hex too). */
const THEME_COLOR = { light: '#f9f5ee', dark: '#12161d' } as const;

/**
 * Resolves the stored theme choice ("light" by default, "dark", or "system") to `data-theme` before
 * first paint, and follows the OS while "system" is chosen. It also keeps a `theme-color` meta of
 * its own first in <head>, so the browser chrome matches the chosen theme rather than the OS (the
 * per-scheme metas below are only the fallback without script). Kept tiny and inline on purpose.
 */
const THEME_SCRIPT = `(function(){var d=document.documentElement,m=window.matchMedia('(prefers-color-scheme: dark)'),t=document.createElement('meta');t.name='theme-color';document.head.prepend(t);function a(){var c='light';try{c=localStorage.getItem('ol-theme')||'light'}catch(e){c=d.dataset.themeChoice||'light'}d.dataset.themeChoice=c;d.dataset.theme=c==='system'?(m.matches?'dark':'light'):c;t.content=d.dataset.theme==='dark'?'${THEME_COLOR.dark}':'${THEME_COLOR.light}'}a();m.addEventListener('change',a);window.addEventListener('ol-theme',a)})()`;

export function Layout({ children }: { children: React.ReactNode }) {
  const nonce = useContext(NonceContext);
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover lets pages pad themselves with the safe-area insets (app.css). */}
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta
          name="theme-color"
          media="(prefers-color-scheme: light)"
          content={THEME_COLOR.light}
        />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={THEME_COLOR.dark} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  return (
    <>
      <Outlet />
      <RouteAnnouncer />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = 'Something went wrong';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;
  if (isRouteErrorResponse(error)) {
    // Loaders refuse with `{ error }` in operator words (a role that's too low, say); show that
    // rather than the HTTP reason phrase.
    const said =
      error.data && typeof error.data === 'object' && typeof error.data.error === 'string'
        ? (error.data.error as string)
        : null;
    title =
      error.status === 404
        ? 'Not found'
        : error.status === 403
          ? 'Not with your role'
          : `Error ${error.status}`;
    details =
      error.status === 404 ? 'That page does not exist.' : said || error.statusText || details;
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
