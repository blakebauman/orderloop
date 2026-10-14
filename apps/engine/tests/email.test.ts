import { introspectWorkflow } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { OrderState } from '@orderloop/core';
import { createDb, inboundEmails } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { receiveEmail } from '../src/email';
import { ensureTemplates } from '../src/flows';

type Sent = { reject?: string; replies: unknown[] };

/** A ForwardableEmailMessage over a raw RFC 5322 message, recording rejects and replies. */
function inbound(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  messageId: string;
  auth?: string;
  csv?: string;
}) {
  const boundary = 'b1';
  const lines = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    `Message-ID: ${opts.messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    opts.body,
  ];
  if (opts.csv) {
    lines.push(
      `--${boundary}`,
      'Content-Type: text/csv; name="po.csv"',
      'Content-Disposition: attachment; filename="po.csv"',
      '',
      opts.csv,
    );
  }
  lines.push(`--${boundary}--`, '');
  const raw = new TextEncoder().encode(lines.join('\r\n'));
  const sent: Sent = { replies: [] };
  const headers = new Headers({
    'message-id': opts.messageId,
    subject: opts.subject,
    'authentication-results':
      opts.auth ?? 'mx.cloudflare.net; dkim=pass header.d=example; spf=pass',
  });
  const message = {
    from: opts.from,
    to: opts.to,
    headers,
    raw: new Blob([raw]).stream(),
    rawSize: raw.byteLength,
    setReject: (r: string) => {
      sent.reject = r;
    },
    forward: async () => ({ messageId: 'fwd' }),
    reply: async (m: unknown) => {
      sent.replies.push(m);
      return { messageId: 'reply' };
    },
  } as unknown as ForwardableEmailMessage;
  return { message, sent };
}

const db = () => createDb(env.DB);
const state = async (id: string) => (await env.ORDER_AGENT.getByName(id).snapshot()) as OrderState;
let introspector: Awaited<ReturnType<typeof introspectWorkflow>>;

beforeAll(async () => {
  await ensureTemplates(env);
});
beforeEach(async () => {
  introspector = await introspectWorkflow(env.ORDER_LOOP);
  await introspector.modifyAll(async (m) => {
    await m.disableSleeps();
  });
});
afterEach(async () => {
  await introspector.dispose();
});

describe('email intake', () => {
  it('turns a customer PO email with a CSV attachment into a B2B order, once', async () => {
    const mail = {
      from: 'purchasing@northwind.example',
      to: 'orders@orderloop.io',
      subject: 'PO NW-4411',
      messageId: '<po-4411@northwind.example>',
      body: 'Hello, please ship the attached. Also 30 x GSK-010.',
      csv: 'sku,qty\n80 x WID-100\n',
    };
    const first = inbound(mail);
    const out = await receiveEmail(first.message, env);
    expect(out).toMatchObject({ status: 'accepted' });
    expect(first.sent.reject).toBeUndefined();
    expect(first.sent.replies).toHaveLength(1);
    expect(first.sent.replies[0]).toMatchObject({ subject: 'Re: PO NW-4411' });
    const orderId = (out as { orderId: string }).orderId;

    const s = await state(orderId);
    expect(s.order).toMatchObject({
      customerId: 'cus_northwind',
      title: 'PO NW-4411',
      model: 'b2b',
    });
    expect(s.order!.documentText).toContain('--- Attachment: po.csv ---');
    expect(s.order!.meta).toMatchObject({
      via: 'email',
      senderMatch: 'customer',
      attachments: ['po.csv'],
    });
    expect(await env.DOCS.head(`orders/${orderId}/inbound/message.eml`)).not.toBeNull();

    // The AI extract node reads lines from the body and the attachment.
    const extracted = await (async () => {
      for (let i = 0; i < 100; i++) {
        const x = await state(orderId);
        if (x.nodes.extract?.status === 'succeeded') return x;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('extract never ran');
    })();
    expect(extracted.order!.lines.map((l) => [l.sku, l.qty]).sort()).toEqual([
      ['GSK-010', 30],
      ['WID-100', 80],
    ]);

    // Email Routing may redeliver: same Message-ID, same order, no second reply.
    const again = inbound(mail);
    expect(await receiveEmail(again.message, env)).toEqual({ status: 'duplicate', orderId });
    expect(again.sent.replies).toHaveLength(0);
    const rows = await db()
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.messageId, mail.messageId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'accepted', orderId, attachments: 1 });
  });

  it('rejects unknown senders, unknown mailboxes and unauthenticated mail', async () => {
    const stranger = inbound({
      from: 'eve@evil.example',
      to: 'orders@orderloop.io',
      subject: 'x',
      body: 'x',
      messageId: '<a@evil>',
    });
    expect(await receiveEmail(stranger.message, env)).toEqual({
      status: 'rejected',
      reason: 'Sender is not a known customer',
    });
    expect(stranger.sent.reject).toBe('Sender is not a known customer');

    const noBox = inbound({
      from: 'purchasing@northwind.example',
      to: 'hello@orderloop.io',
      subject: 'x',
      body: 'x',
      messageId: '<b@nw>',
    });
    expect(await receiveEmail(noBox.message, env)).toMatchObject({ status: 'rejected' });

    const spoof = inbound({
      from: 'purchasing@northwind.example',
      to: 'orders@orderloop.io',
      subject: 'x',
      body: 'x',
      messageId: '<c@nw>',
      auth: 'mx.cloudflare.net; dmarc=fail; spf=fail',
    });
    expect(await receiveEmail(spoof.message, env)).toEqual({
      status: 'rejected',
      reason: 'Message failed SPF, DKIM and DMARC',
    });

    const rejected = await db()
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.status, 'rejected'));
    expect(rejected.map((r) => r.messageId).sort()).toEqual(['<a@evil>', '<b@nw>', '<c@nw>']);
  });

  it('accepts an allowlisted sender and routes purchasing@ to a purchase request', async () => {
    const mail = inbound({
      from: 'Me@Example.org',
      to: 'purchasing@orderloop.io',
      subject: 'Two monitors',
      body: '2 x MON-27 for the design team',
      messageId: '<d@example.org>',
    });
    const out = await receiveEmail(mail.message, {
      ...env,
      INTAKE_ALLOWLIST: 'me@example.org',
    } as Env);
    expect(out).toMatchObject({ status: 'accepted' });
    const s = await state((out as { orderId: string }).orderId);
    expect(s.order).toMatchObject({ model: 'procurement', customerId: undefined });
    expect(s.order!.meta).toMatchObject({ senderMatch: 'allowlist' });
  });
});
