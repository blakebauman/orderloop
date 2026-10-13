/** Describing sessions on the Account page. Pure. */

/** "Chrome on macOS" from a User-Agent string; good enough to tell your devices apart. */
export function describeAgent(ua: string | null | undefined): string {
  if (!ua) return 'Unknown browser';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : /curl\//.test(ua)
              ? 'curl'
              : 'Unknown browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return os ? `${browser} on ${os}` : browser;
}

/**
 * A short public reference for a session: the first 16 hex characters of its token hash. The
 * Account page uses it to end one session; it reveals nothing about the cookie.
 */
export const sessionRef = (tokenHash: string) => tokenHash.slice(0, 16);
