/**
 * EDI X12 850 purchase orders as inbound orders. Pure: `parseX12` splits an interchange into its
 * transactions using the delimiters its ISA header declares, and `x12850ToInbound` maps one 850 onto
 * an inbound order for the trading partner's customer. Transport (AS2, SFTP, a VAN) and 997
 * acknowledgements are out of scope; a partner's provider posts the raw X12 to the API.
 */

import type { ChannelResult } from './shopify';

export type X12Segment = { id: string; el: string[] };
export type X12Transaction = { type: string; control: string; segments: X12Segment[] };
export type X12Interchange = { sender: string; receiver: string; transactions: X12Transaction[] };

export type X12Parse = { ok: true; interchange: X12Interchange } | { ok: false; error: string };

/**
 * The ISA segment is fixed width: the element separator is its 4th character, the component
 * separator the 105th and the segment terminator the 106th.
 */
export function parseX12(text: string): X12Parse {
  const raw = text.replace(/^﻿/, '').trimStart();
  if (!raw.startsWith('ISA') || raw.length < 106)
    return {
      ok: false,
      error: 'Not an X12 interchange: it must start with a 106-character ISA segment',
    };
  const element = raw[3]!;
  const terminator = raw[105]!;
  const segments = raw
    .split(terminator)
    .map((s) => s.replace(/^[\r\n]+|[\r\n]+$/g, ''))
    .filter(Boolean)
    .map((s) => {
      const [id, ...el] = s.split(element);
      return { id: id!.trim(), el: el.map((e) => e.trim()) };
    });
  const isa = segments[0]!;
  const transactions: X12Transaction[] = [];
  let open: X12Transaction | null = null;
  for (const seg of segments) {
    if (seg.id === 'ST') {
      if (open) return { ok: false, error: `ST ${open.control} has no SE before the next ST` };
      open = { type: seg.el[0] ?? '', control: seg.el[1] ?? '', segments: [] };
    } else if (seg.id === 'SE') {
      if (!open) return { ok: false, error: 'SE without an ST' };
      // SE01 counts the segments from ST to SE inclusive.
      const count = Number(seg.el[0]);
      if (count !== open.segments.length + 2)
        return {
          ok: false,
          error: `SE for ${open.control} counts ${seg.el[0]} segments; the transaction has ${open.segments.length + 2}`,
        };
      transactions.push(open);
      open = null;
    } else if (open) open.segments.push(seg);
  }
  if (open) return { ok: false, error: `ST ${open.control} has no SE` };
  if (!transactions.length) return { ok: false, error: 'The interchange has no transactions' };
  return {
    ok: true,
    interchange: { sender: isa.el[5] ?? '', receiver: isa.el[7] ?? '', transactions },
  };
}

/** Part-number qualifiers in a PO1, in the order they are trusted as OrderLoop's SKU. */
const SKU_QUALIFIERS = ['VP', 'SK', 'BP', 'IN'];

/** One 850 as an inbound B2B order from the partner `sender`, billed to `customerId`. */
export function x12850ToInbound(
  tx: X12Transaction,
  partner: { sender: string; customerId: string },
): ChannelResult {
  if (tx.type !== '850')
    return { ok: false, error: `Transaction ${tx.control} is a ${tx.type}, not an 850` };
  const first = (id: string) => tx.segments.find((s) => s.id === id);
  const beg = first('BEG');
  const po = beg?.el[2];
  if (!po)
    return { ok: false, error: `Transaction ${tx.control} has no BEG03 purchase order number` };

  const lines = [];
  for (const [i, s] of tx.segments.entries()) {
    if (s.id !== 'PO1') continue;
    const qty = Number(s.el[1]);
    const price = s.el[3] ? Number(s.el[3]) : undefined;
    const ids = new Map<string, string>();
    for (let k = 5; k + 1 < s.el.length; k += 2)
      if (s.el[k] && s.el[k + 1]) ids.set(s.el[k]!, s.el[k + 1]!);
    const sku = SKU_QUALIFIERS.map((q) => ids.get(q)).find(Boolean);
    if (!sku)
      return {
        ok: false,
        error: `PO ${po} line ${s.el[0] || lines.length + 1} has no VP, SK, BP or IN part number`,
      };
    if (!(qty > 0))
      return { ok: false, error: `PO ${po} line ${s.el[0] || lines.length + 1} has no quantity` };
    // A PID right after the PO1 describes the item.
    const pid = tx.segments[i + 1]?.id === 'PID' ? tx.segments[i + 1]!.el[4] : undefined;
    lines.push({
      sku,
      qty,
      ...(price !== undefined && Number.isFinite(price) ? { unitPrice: price } : {}),
      ...(pid ? { name: pid } : {}),
    });
  }
  if (!lines.length) return { ok: false, error: `PO ${po} has no PO1 lines` };
  const ctt = first('CTT')?.el[0];
  if (ctt && Number(ctt) !== lines.length)
    return {
      ok: false,
      error: `PO ${po}: CTT says ${ctt} lines, the transaction has ${lines.length}`,
    };

  // Ship-to: the N1*ST loop, with its N3 street and N4 city, region, postcode and country.
  const n1 = tx.segments.findIndex((s) => s.id === 'N1' && s.el[0] === 'ST');
  const loop = n1 < 0 ? [] : tx.segments.slice(n1 + 1, n1 + 4);
  const n3 = loop.find((s) => s.id === 'N3');
  const n4 = loop.find((s) => s.id === 'N4');
  const shipTo =
    n3?.el[0] && n4?.el[0] && n4.el[2]
      ? {
          ...(tx.segments[n1]!.el[1] ? { name: tx.segments[n1]!.el[1] } : {}),
          line1: n3.el[0],
          ...(n3.el[1] ? { line2: n3.el[1] } : {}),
          city: n4.el[0],
          ...(n4.el[1] ? { region: n4.el[1] } : {}),
          postalCode: n4.el[2],
          country: n4.el[3] || 'US',
        }
      : undefined;

  return {
    ok: true,
    order: {
      model: 'b2b',
      channel: 'edi',
      externalId: `${partner.sender}:${po}`,
      source: 'x12-850',
      title: `PO ${po}`,
      customerId: partner.customerId,
      currency: first('CUR')?.el[1] || 'USD',
      lines,
      ...(shipTo ? { shipTo } : {}),
      meta: {
        edi: {
          sender: partner.sender,
          poNumber: po,
          control: tx.control,
          date: beg?.el[4] ?? null,
        },
      },
    },
  };
}

/** `EDI_PARTNERS`: JSON from an interchange sender id (ISA06) to the customer it orders for. */
export function parseEdiPartners(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v))
      return Object.fromEntries(
        Object.entries(v)
          .filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '')
          .map(([k, c]) => [k.trim(), c]),
      );
  } catch {
    // no partners
  }
  return {};
}
