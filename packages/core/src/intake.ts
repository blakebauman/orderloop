/**
 * Email intake decisions, kept pure so they are unit tested here: which flow a mailbox starts,
 * whether a sender may start orders, whether the message authenticated, and the document text the
 * AI extract node reads. The engine's `email()` entrypoint does the I/O around them.
 */

/** Local part → flow id. `orders@` and `po@` start B2B orders; `purchasing@` starts requests. */
export const DEFAULT_INTAKE_MAILBOXES: Record<string, string> = {
  orders: 'tpl-b2b-order',
  po: 'tpl-b2b-order',
  purchasing: 'tpl-purchase-request',
};

/** Largest message the intake accepts; Email Routing itself caps messages at 25 MiB. */
export const MAX_INTAKE_BYTES = 10 * 1024 * 1024;

/** Mirrors the `documentText` limit on order input. */
export const MAX_DOCUMENT_CHARS = 50_000;

/** Webmail domains never identify a customer by domain alone. */
const FREEMAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'aol.com',
  'gmx.com',
]);

export function parseMailboxes(raw: string | undefined): Record<string, string> {
  if (!raw?.trim()) return DEFAULT_INTAKE_MAILBOXES;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const entries = Object.entries(v).filter(
        (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== '',
      );
      if (entries.length) return Object.fromEntries(entries.map(([k, f]) => [k.toLowerCase(), f]));
    }
  } catch {
    // fall through to defaults
  }
  return DEFAULT_INTAKE_MAILBOXES;
}

export function splitAddress(address: string): { local: string; domain: string } {
  const a = address
    .trim()
    .toLowerCase()
    .replace(/^.*<|>.*$/g, '');
  const at = a.lastIndexOf('@');
  return at < 0 ? { local: a, domain: '' } : { local: a.slice(0, at), domain: a.slice(at + 1) };
}

/** The flow a recipient address starts, ignoring `+tags` (orders+acme@ → orders). */
export function flowForMailbox(to: string, mailboxes: Record<string, string>): string | undefined {
  const local = splitAddress(to).local.split('+')[0]!;
  return mailboxes[local];
}

export type KnownSender = { id: string; email: string };

/**
 * Who may start orders by email: a customer's exact address, another address at a customer's
 * (non-webmail) domain, or an allowlist entry (`someone@x.com` or `@x.com`).
 */
export function resolveSender(
  from: string,
  customers: KnownSender[],
  allowlist: string | undefined,
): { allowed: boolean; customerId?: string; via?: 'customer' | 'domain' | 'allowlist' } {
  const { domain } = splitAddress(from);
  const addr = splitAddress(from);
  const full = `${addr.local}@${addr.domain}`;
  const exact = customers.find((c) => c.email.toLowerCase() === full);
  if (exact) return { allowed: true, customerId: exact.id, via: 'customer' };
  if (domain && !FREEMAIL.has(domain)) {
    const byDomain = customers.filter((c) => splitAddress(c.email).domain === domain);
    if (byDomain.length === 1) return { allowed: true, customerId: byDomain[0]!.id, via: 'domain' };
  }
  const entries = (allowlist ?? '')
    .split(/[,\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (entries.some((e) => (e.startsWith('@') ? domain === e.slice(1) : full === e))) {
    return { allowed: true, via: 'allowlist' };
  }
  return { allowed: false };
}

/**
 * True when the receiving MTA recorded a passing DMARC, DKIM or SPF result, so the From address is
 * not trivially spoofed. Email Routing adds `Authentication-Results` before the Worker runs.
 */
export function authenticated(authResults: string | null): boolean {
  if (!authResults) return false;
  return /\b(dmarc|dkim|spf)=pass\b/i.test(authResults);
}

export type IntakeAttachment = { filename: string; text: string };

/** The text the AI extract node reads: headers that matter, the body, then each attachment. */
export function composeDocument(input: {
  from: string;
  subject: string;
  text: string;
  attachments: IntakeAttachment[];
}): string {
  const parts = [`From: ${input.from}`, `Subject: ${input.subject}`, '', input.text.trim()];
  for (const a of input.attachments) {
    if (a.text.trim()) parts.push('', `--- Attachment: ${a.filename} ---`, a.text.trim());
  }
  const doc = parts.join('\n');
  return doc.length > MAX_DOCUMENT_CHARS
    ? `${doc.slice(0, MAX_DOCUMENT_CHARS - 20)}\n[truncated]`
    : doc;
}

/** Strips tags from an HTML-only body well enough for extraction. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}
