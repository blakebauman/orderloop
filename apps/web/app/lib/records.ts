/**
 * What orders did to the outside world, for the Commerce page: the shared shape of a record row,
 * how to read the step that wrote it from its id, and which status colour each outcome takes.
 * Pure; runs on both sides.
 */

export const RECORD_KINDS = [
  { id: 'money', label: 'Money' },
  { id: 'shipments', label: 'Shipments' },
  { id: 'holds', label: 'Stock holds' },
  { id: 'sellers', label: 'Seller orders' },
  { id: 'messages', label: 'Messages' },
  { id: 'documents', label: 'Documents' },
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number]['id'];

export type RecordRow = {
  id: string;
  kind: RecordKind;
  orderId: string;
  orderTitle: string;
  customer: string | null;
  /** What it is, e.g. "Capture", "UPS 1Z…", "8 × LAP-14 at SoHo". */
  what: string;
  /** A second line: recipient, provider, reason. */
  detail: string | null;
  amount: number | null;
  currency: string | null;
  status: string | null;
  /** The step that wrote it, e.g. "capture#1", read from the row id. */
  step: string | null;
  at: number;
};

/**
 * Connector rows are keyed `${prefix}_${orderId}_${stepKey}…`, with `#` and other non-word
 * characters as `_` (`rowId` in the engine). The step key is what follows the order id: "authorize_1"
 * reads "authorize#1"; a reservation's "reserve_1_0_WID-100" reads "reserve#1". A capture puts it
 * before the order id instead ("cap_capture_1_ord_x").
 */
export function stepOf(id: string, orderId: string): string | null {
  const key = (s: string) => {
    const m = /^(.+?)_(\d+)(?:_.*)?$/.exec(s);
    return m ? `${m[1]}#${m[2]}` : s || null;
  };
  const at = id.indexOf(`_${orderId}`);
  if (at < 0) return null;
  const after = id.slice(at + orderId.length + 1);
  if (after.startsWith('_')) return key(after.slice(1));
  // The order id ends the row id (captures): the step sits between the prefix and it.
  const first = id.indexOf('_');
  return first >= 0 && first < at ? key(id.slice(first + 1, at)) : null;
}

const TONE: Record<string, 'ok' | 'bad' | 'undo' | 'wait' | 'idle'> = {
  succeeded: 'ok',
  captured: 'ok',
  paid: 'ok',
  delivered: 'ok',
  collected: 'ok',
  consumed: 'ok',
  accepted: 'ok',
  shipped: 'ok',
  issued: 'ok',
  sent: 'ok',
  failed: 'bad',
  declined: 'bad',
  rejected: 'bad',
  voided: 'undo',
  refunded: 'undo',
  released: 'undo',
  reversed: 'undo',
  revoked: 'undo',
  cancelled: 'undo',
  restored: 'undo',
  returned: 'undo',
  authorized: 'wait',
  held: 'wait',
  pending: 'wait',
  open: 'wait',
  scheduled: 'wait',
  label_created: 'wait',
  return_label: 'wait',
  ready_for_pickup: 'wait',
};

/** The status token for an outcome; anything unknown is neutral. */
export const recordTone = (status: string | null) => (status ? (TONE[status] ?? 'idle') : 'idle');
