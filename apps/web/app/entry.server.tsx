import { isbot } from 'isbot';
import { renderToReadableStream } from 'react-dom/server';
import type { EntryContext, RouterContextProvider } from 'react-router';
import { ServerRouter } from 'react-router';
import { NonceContext, newNonce, pageHeaders } from './lib/csp';

export const streamTimeout = 5_000;

/** React Router's default web entry, plus a per-response CSP nonce for every inline script. */
export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  if (request.method.toUpperCase() === 'HEAD') {
    return new Response(null, {
      status: responseStatusCode,
      headers: pageHeaders(responseHeaders),
    });
  }

  const nonce = newNonce();
  let shellRendered = false;
  const userAgent = request.headers.get('user-agent');

  const body = await renderToReadableStream(
    <NonceContext.Provider value={nonce}>
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
    </NonceContext.Provider>,
    {
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors before the shell rendered reject and are logged by handleDocumentRequest.
        if (shellRendered) console.error(error);
      },
    },
  );
  shellRendered = true;

  // Bots and SPA mode get the whole document at once.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) await body.allReady;

  responseHeaders.set('Content-Type', 'text/html');
  // The policy, with what the route asked for: an external cart's framers and return URL, or
  // Turnstile on sign-in and setup. Vite's dev server injects its own inline scripts, which carry
  // no nonce, so it gets none.
  pageHeaders(responseHeaders, import.meta.env.DEV ? undefined : nonce);
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
