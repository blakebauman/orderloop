/**
 * Where to go after signing in: the `next` query parameter when it resolves to a path on this
 * site, else `/`. Resolving it the way a browser would catches `//host`, `/\host` and the like.
 */
export function nextPath(request: Request): string {
  const url = new URL(request.url);
  const next = url.searchParams.get('next');
  if (!next?.startsWith('/') || next.includes('\\')) return '/';
  try {
    const target = new URL(next, url.origin);
    return target.origin === url.origin ? `${target.pathname}${target.search}${target.hash}` : '/';
  } catch {
    return '/';
  }
}

/** `path` carrying `next`, left off when it's `/`, where sign-in goes anyway. */
export function withNext(path: string, next: string): string {
  return next === '/' ? path : `${path}?next=${encodeURIComponent(next)}`;
}
