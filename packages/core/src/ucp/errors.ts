/**
 * UCP's two kinds of failure. A protocol error (bad credentials, an unknown session, a reused
 * idempotency key, a rate limit) is a non-2xx status with `{ code, content }`. A business outcome
 * (an item out of stock, a declined card) is HTTP 200 with the UCP envelope and `messages`; when
 * there is no resource to return at all, that is an error response (`ucp.status: "error"`).
 */

import type { CheckoutIssue } from '../checkout';

export const UCP_VERSION = '2026-08-25';

/** A protocol error's body. */
export const ucpError = (code: string, content: string) => ({ code, content });

/** A UCP message (`common/types/message.json`) from a checkout issue. */
export function ucpMessage(i: CheckoutIssue) {
  return {
    type: i.kind,
    code: i.code,
    content: i.content,
    ...(i.path ? { path: i.path } : {}),
    ...(i.kind === 'error' ? { severity: i.severity ?? 'recoverable' } : {}),
  };
}

/** A business outcome with no resource behind it (`common/types/error_response.json`). */
export function ucpErrorResponse(issues: CheckoutIssue[], continueUrl?: string) {
  return {
    ucp: { version: UCP_VERSION, status: 'error' as const },
    messages: issues.map(ucpMessage),
    ...(continueUrl ? { continue_url: continueUrl } : {}),
  };
}
