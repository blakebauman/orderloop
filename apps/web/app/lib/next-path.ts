/** Where to go after signing in: the `next` query parameter when it is a path on this site. */
export function nextPath(request: Request): string {
  const next = new URL(request.url).searchParams.get('next');
  return next?.startsWith('/') && !next.startsWith('//') ? next : '/';
}
