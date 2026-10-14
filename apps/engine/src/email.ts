/**
 * Email intake: the Worker `email()` entrypoint Cloudflare Email Routing delivers to.
 *
 * A message to a configured mailbox (orders@, po@, purchasing@ by default; INTAKE_MAILBOXES)
 * from an authenticated, recognised sender starts an order on that mailbox's flow. The body and
 * attachments (PDF, Office, CSV, HTML via Workers AI `toMarkdown`) become the order's
 * `documentText` for the AI extract node, the raw .eml goes to R2, and the sender gets an
 * acknowledgement reply. The Message-ID is the idempotency key, so a redelivered message never
 * starts a second order. Everything else is rejected at SMTP time with a reason, and every
 * message is recorded in `inbound_emails`.
 */

import {
  authenticated,
  composeDocument,
  flowForMailbox,
  htmlToText,
  type IntakeAttachment,
  MAX_INTAKE_BYTES,
  parseMailboxes,
  resolveSender,
  splitAddress,
} from '@orderloop/core';
import { createDb, customers, documents, inboundEmails } from '@orderloop/db';
import PostalMime, { type Attachment } from 'postal-mime';
import { loadFlowVersion } from './flows';
import { startOrderOnce } from './orders';

/** Attachments the intake reads directly as text. */
const TEXT_TYPES = /^(text\/(plain|csv|tab-separated-values)|application\/(json|xml))/i;
/** Attachments sent to Workers AI `toMarkdown` (PDF, Office, HTML, images). */
const CONVERT_TYPES =
  /^(application\/(pdf|vnd\.openxmlformats|vnd\.ms-excel|vnd\.oasis\.opendocument)|text\/html|image\/(png|jpe?g|webp))/i;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

export type IntakeOutcome =
  | { status: 'accepted'; orderId: string; replayed: boolean }
  | { status: 'rejected'; reason: string }
  | { status: 'duplicate'; orderId?: string };

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
): Promise<IntakeOutcome> {
  const db = createDb(env.DB);
  const receivedAt = Date.now();
  const messageId =
    message.headers.get('message-id')?.trim() || `<no-id-${receivedAt}-${crypto.randomUUID()}>`;
  const subject = (message.headers.get('subject') ?? '').slice(0, 300);
  const mailbox = splitAddress(message.to);
  const record = (fields: Partial<typeof inboundEmails.$inferInsert> & { status: string }) =>
    db
      .insert(inboundEmails)
      .values({
        id: `eml_${receivedAt.toString(36)}${crypto.randomUUID().slice(0, 8)}`,
        messageId,
        mailbox: `${mailbox.local}@${mailbox.domain}`,
        sender: message.from.toLowerCase(),
        subject,
        receivedAt,
        ...fields,
      })
      .onConflictDoNothing();
  const reject = async (reason: string): Promise<IntakeOutcome> => {
    message.setReject(reason);
    await record({ status: 'rejected', reason });
    return { status: 'rejected', reason };
  };

  const flowId = flowForMailbox(message.to, parseMailboxes(env.INTAKE_MAILBOXES));
  if (!flowId) return reject(`No mailbox ${mailbox.local}@ here`);
  if (message.rawSize > MAX_INTAKE_BYTES) return reject('Message too large');
  if (
    String(env.INTAKE_REQUIRE_AUTH) !== 'false' &&
    !authenticated(message.headers.get('authentication-results'))
  ) {
    return reject('Message failed SPF, DKIM and DMARC');
  }
  const known = await db.select({ id: customers.id, email: customers.email }).from(customers);
  const sender = resolveSender(message.from, known, env.INTAKE_ALLOWLIST);
  if (!sender.allowed) return reject('Sender is not a known customer');

  const flow = await loadFlowVersion(env, flowId);
  if (!flow) return reject('Mailbox is not configured');

  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const parsed = await PostalMime.parse(raw);
  const attachments = await readAttachments(env, parsed.attachments ?? []);
  const text = parsed.text?.trim() || (parsed.html ? htmlToText(parsed.html) : '');
  const documentText = composeDocument({ from: message.from, subject, text, attachments });

  const result = await startOrderOnce(env, {
    flowId,
    idempotencyKey: `email:${messageId}`,
    input: {
      model: flow.model,
      channel: 'email',
      title: subject || `Email from ${message.from}`,
      customerId: sender.customerId,
      currency: 'USD',
      lines: [],
      documentText,
      meta: {
        via: 'email',
        from: message.from,
        to: message.to,
        subject,
        messageId,
        senderMatch: sender.via,
        attachments: attachments.map((a) => a.filename),
      },
    },
  });
  if ('mismatch' in result) return reject('Message-ID reused for a different message');

  // The raw message, kept with the order's other documents.
  const r2Key = `orders/${result.orderId}/inbound/message.eml`;
  await env.DOCS.put(r2Key, raw, { httpMetadata: { contentType: 'message/rfc822' } });
  await db
    .insert(documents)
    .values({
      id: r2Key,
      orderId: result.orderId,
      kind: 'email',
      r2Key,
      contentType: 'message/rfc822',
      createdAt: receivedAt,
    })
    .onConflictDoNothing();

  if (result.replayed) {
    await record({
      status: 'duplicate',
      orderId: result.orderId,
      r2Key,
      attachments: attachments.length,
    });
    return { status: 'duplicate', orderId: result.orderId };
  }
  await record({
    status: 'accepted',
    orderId: result.orderId,
    r2Key,
    attachments: attachments.length,
  });

  if (String(env.INTAKE_REPLY) !== 'false') {
    try {
      await message.reply({
        from: { email: message.to, name: 'OrderLoop' },
        subject: subject.toLowerCase().startsWith('re:')
          ? subject
          : `Re: ${subject || 'your order'}`,
        text: [
          `Thanks, we received your ${flow.model === 'procurement' ? 'request' : 'order'}.`,
          '',
          `Reference: ${result.orderId}`,
          `It is now being processed${attachments.length ? ` (${attachments.length} attachment${attachments.length === 1 ? '' : 's'} read)` : ''}. We will email you if we need anything else.`,
          '',
          '— OrderLoop',
        ].join('\n'),
      });
    } catch (err) {
      // Replies need a DMARC-aligned original; a failed acknowledgement never fails intake.
      console.warn('intake reply failed', err instanceof Error ? err.message : err);
    }
  }
  return { status: 'accepted', orderId: result.orderId, replayed: false };
}

async function readAttachments(env: Env, atts: Attachment[]): Promise<IntakeAttachment[]> {
  const out: IntakeAttachment[] = [];
  for (const a of atts) {
    const filename = a.filename || 'attachment';
    const bytes =
      typeof a.content === 'string'
        ? new TextEncoder().encode(a.content)
        : new Uint8Array(a.content);
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) continue;
    if (TEXT_TYPES.test(a.mimeType)) {
      out.push({ filename, text: new TextDecoder().decode(bytes) });
    } else if (CONVERT_TYPES.test(a.mimeType) && String(env.AI_MODE) !== 'mock') {
      try {
        const res = await env.AI.toMarkdown({
          name: filename,
          blob: new Blob([bytes], { type: a.mimeType }),
        });
        if (res.format !== 'error') out.push({ filename, text: res.data });
      } catch (err) {
        console.warn('toMarkdown failed', filename, err instanceof Error ? err.message : err);
      }
    }
  }
  return out;
}
