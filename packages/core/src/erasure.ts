/**
 * Data subject requests: everything held about one person, found by their email address, can be
 * exported or erased (`POST /api/v1/data-subjects/export` and `/erase`). Erasing keeps the
 * commercial record (lines, amounts, payments, shipments, the ledgers) and removes who it was
 * for: contact details, names, addresses, the inbound document and email, and messages sent.
 * The audit log is kept as it is, under its own retention.
 */

import { fingerprintOf, type OrderState } from './api';
import { maskPersonalText, scrubPersonal } from './redact';

/** What an erased value reads as. */
export const ERASED = '[erased]';

/** A subject's email as matched: trimmed and lower-cased. */
export const subjectEmail = (email: string) => email.trim().toLowerCase();

/** The audit log's name for a data subject: a hash of their address, so the log doesn't keep it. */
export const subjectTarget = async (email: string) =>
  `subject:${(await fingerprintOf(subjectEmail(email))).slice(0, 16)}`;

/** The address an erased customer keeps, since every customer needs one. */
export const erasedCustomerEmail = (customerId: string) => `erased-${customerId}@erased.invalid`;

/**
 * The words that identify the subject beyond what the patterns catch: their email and the names
 * on their customer accounts and orders. Very short names are left out so they don't match
 * ordinary words.
 */
export function erasureTerms(values: (string | null | undefined)[]): string[] {
  const terms = new Set<string>();
  for (const v of values) {
    const t = v?.trim();
    if (t && t.length >= 3) terms.add(t);
  }
  // Longest first, so "Jane Doe" goes before "Jane".
  return [...terms].sort((a, b) => b.length - a.length);
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Text with the subject's terms replaced and any email or phone number masked. */
export function eraseText(text: string, terms: string[]): string {
  let out = text;
  for (const t of terms) out = out.replace(new RegExp(literal(t), 'giu'), ERASED);
  return maskPersonalText(out);
}

/** A JSON value with personal keys dropped and the subject's terms erased from every string. */
export function eraseValue(value: unknown, terms: string[]): unknown {
  const scrubbed = scrubPersonal(value);
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return eraseText(v, terms);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object')
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(scrubbed);
}

/**
 * An order's state with the subject erased: no contact, document text or personal `meta`, and
 * their terms gone from the title, vars, step outputs and summaries, the timeline and the reason.
 * The flow, lines, amounts and statuses stay.
 */
export function eraseOrderState<S extends OrderState>(state: S, subjectTerms: string[]): S {
  const shipTo = state.order?.meta?.shipTo as Record<string, unknown> | undefined;
  const c = state.order?.contact;
  const terms = erasureTerms([
    ...subjectTerms,
    c?.name,
    c?.email,
    c?.phone,
    typeof shipTo?.name === 'string' ? shipTo.name : undefined,
  ]);
  const text = (s: string | undefined) => (s === undefined ? s : eraseText(s, terms));
  const order = state.order && {
    ...state.order,
    title: text(state.order.title),
    contact: undefined,
    documentText: undefined,
    documentKey: undefined,
    meta: eraseValue(state.order.meta ?? {}, terms) as Record<string, unknown>,
    lines: state.order.lines.map((l) => ({ ...l, name: text(l.name) })),
  };
  return {
    ...state,
    order,
    vars: eraseValue(state.vars, terms) as Record<string, unknown>,
    nodes: Object.fromEntries(
      Object.entries(state.nodes).map(([id, n]) => [
        id,
        {
          ...n,
          summary: text(n.summary),
          error: text(n.error),
          output: n.output === undefined ? undefined : eraseValue(n.output, terms),
        },
      ]),
    ),
    timeline: state.timeline.map((t) => ({
      ...t,
      message: eraseText(t.message, terms),
      data: t.data === undefined ? undefined : eraseValue(t.data, terms),
    })),
    reason: text(state.reason),
  };
}

/** The shortest time a deployment may keep a finished order's personal data. */
export const MIN_PERSONAL_DATA_RETENTION_DAYS = 30;

/**
 * Days after an order finishes that the retention sweep erases its buyer, from a deployment's
 * `PERSONAL_DATA_RETENTION_DAYS`; null (empty or unset) keeps it. Kept to the floor.
 */
export function personalDataRetentionDays(value: string | undefined): number | null {
  const days = Number(value);
  if (!value || !Number.isInteger(days) || days <= 0) return null;
  return Math.max(days, MIN_PERSONAL_DATA_RETENTION_DAYS);
}

/** What an erasure did, or why it stopped. */
export type ErasureResult =
  | {
      ok: true;
      /** False when more orders are left: call again to continue. */
      done: boolean;
      orders: number;
      customers: number;
      documents: number;
      messages: number;
      inboundEmails: number;
      /**
       * External carts they were the buyer of (their messages and files removed, the cart kept),
       * and their accounts' staff carts that lost a ship-to.
       */
      carts: number;
      /** Their accounts' tax exemption certificates, deleted with their files. */
      taxCertificates: number;
      /** The places their accounts' orders shipped to, as the customer page lists them. */
      addresses: number;
      /** The address is also a team member's; remove them on the team page. */
      teamMember: boolean;
    }
  /** Orders still running can't be erased; cancel them or wait for them to finish. */
  | { ok: false; reason: 'active_orders'; orders: string[] };

export type SubjectExport = {
  email: string;
  exportedAt: number;
  customers: Record<string, unknown>[];
  orders: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  inboundEmails: Record<string, unknown>[];
  documents: { key: string; kind: string; contentType: string; createdAt: number }[];
  /** Agentic checkout sessions they were the buyer of. */
  checkouts: Record<string, unknown>[];
  /**
   * External carts (a punchout session, say) they were the buyer of, with their messages and
   * files, and their accounts' staff carts that hold a ship-to, with it.
   */
  carts: Record<string, unknown>[];
  /** Their accounts' tax exemption certificates (each file's key, not the file). */
  taxCertificates: Record<string, unknown>[];
  /** The places their accounts' orders shipped to, as the customer page lists them. */
  addresses: Record<string, unknown>[];
  /** True when there were more orders than one export holds. */
  truncated: boolean;
  teamMember: boolean;
};
