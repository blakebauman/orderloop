/**
 * Promotions and tax certificates through the assistant. Each changes what buyers pay, so each
 * stops for a confirm: a new promotion code, pausing or reactivating one, and verifying or revoking
 * a customer's tax exemption certificate. Adding a certificate stays on the customer's page, which
 * stores its file first; an unverified certificate exempts nothing.
 *
 * A certificate's number is the customer's personal data: a card shows only its last four
 * characters, and the stored conversation keeps only the ids.
 */

import {
  type ActionPreview,
  BASE_CURRENCY,
  boundText,
  type Principal,
  type PromotionKind,
  type RpcActor,
  taxCertificateState,
} from '@orderloop/core';
import { createDb, customers, promotions } from '@orderloop/db';
import { eq } from 'drizzle-orm';
import { recordAudit } from '../audit';
import {
  customerTaxCertificates,
  revokeTaxCertificate,
  separated,
  verifyTaxCertificate,
} from '../tax-certificates';
import { money, Refused } from './data';

type Trail = Record<string, unknown>;

export type PromotionInput = {
  code: string;
  name?: string;
  kind: PromotionKind;
  value?: number;
  minSubtotal?: number;
  skus?: string[];
  customerId?: string;
  validTo?: number;
  maxRedemptions?: number;
  perCustomerLimit?: number;
};

const what = (p: { kind: string; value: number }) =>
  p.kind === 'pct'
    ? `${p.value}% off`
    : p.kind === 'amount'
      ? `${money(p.value, BASE_CURRENCY)} off`
      : 'Free shipping';

const customerName = async (env: Env, id: string) =>
  (
    await createDb(env.DB)
      .select({ name: customers.name })
      .from(customers)
      .where(eq(customers.id, id))
      .get()
  )?.name ?? null;

/** Why the promotion can't be made as asked, in the form's words; null when it can. */
function promotionProblem(i: PromotionInput): string | null {
  const value = i.kind === 'free_shipping' ? 0 : (i.value ?? 0);
  if (i.kind === 'pct' && !(value > 0 && value <= 100))
    return 'A percentage is above 0 and at most 100.';
  if (i.kind === 'amount' && !(value > 0)) return 'An amount off is above 0.';
  return null;
}

export async function previewCreatePromotion(
  env: Env,
  i: PromotionInput,
  roleBlock?: string,
): Promise<ActionPreview> {
  const taken = await createDb(env.DB)
    .select({ id: promotions.id })
    .from(promotions)
    .where(eq(promotions.code, i.code))
    .get();
  const value = i.kind === 'free_shipping' ? 0 : (i.value ?? 0);
  const who = i.customerId ? await customerName(env, i.customerId) : null;
  return {
    title: `Add the promotion ${i.code}`,
    href: '/promotions',
    consequences: [
      `${what({ kind: i.kind, value })}${i.name ? ` · “${boundText(i.name, 80)}”` : ''}`,
      ...(i.minSubtotal ? [`On a subtotal of ${money(i.minSubtotal)} or more`] : []),
      ...(i.skus?.length
        ? [
            `Only on ${i.skus.length} SKU${i.skus.length === 1 ? '' : 's'}: ${i.skus
              .slice(0, 6)
              .map((s) => `“${boundText(s, 40) ?? ''}”`)
              .join(', ')}${i.skus.length > 6 ? ` and ${i.skus.length - 6} more` : ''}`,
          ]
        : []),
      i.customerId ? `Only for ${boundText(who, 80) ?? i.customerId}` : 'For any buyer',
      ...(i.validTo
        ? [`Until ${new Date(i.validTo).toISOString().slice(0, 10)}`]
        : ['No end date']),
      ...(i.maxRedemptions ? [`At most ${i.maxRedemptions} uses`] : []),
      ...(i.perCustomerLimit ? [`At most ${i.perCustomerLimit} per customer`] : []),
      'Active at once: buyers and staff can enter it on carts and at checkout',
    ],
    blocked:
      roleBlock ??
      promotionProblem(i) ??
      (taken ? `${i.code} already exists.` : undefined) ??
      (i.customerId && !who ? 'That customer no longer exists.' : undefined),
  };
}

export async function runCreatePromotion(env: Env, p: Principal, i: PromotionInput, trail: Trail) {
  const now = Date.now();
  const id = `promo_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const value = i.kind === 'free_shipping' ? 0 : (i.value ?? 0);
  try {
    await createDb(env.DB)
      .insert(promotions)
      .values({
        id,
        code: i.code,
        name: (i.name ?? '').slice(0, 120),
        kind: i.kind,
        value,
        minSubtotal: i.minSubtotal ?? null,
        skus: i.skus?.length ? JSON.stringify(i.skus) : null,
        customerId: i.customerId ?? null,
        validTo: i.validTo ?? null,
        maxRedemptions: i.maxRedemptions ?? null,
        perCustomerLimit: i.perCustomerLimit ?? null,
        createdBy: p.id,
        createdAt: now,
        updatedAt: now,
      });
  } catch {
    throw new Refused(`${i.code} already exists.`);
  }
  await recordAudit(env, 'promotion.saved', {
    actor: p,
    target: id,
    // Its whole reach, so the record of a wide code says how wide.
    detail: {
      code: i.code,
      kind: i.kind,
      value,
      ...(i.name ? { name: i.name.slice(0, 120) } : {}),
      customerId: i.customerId ?? null,
      skus: i.skus?.length ?? 0,
      minSubtotal: i.minSubtotal ?? null,
      validTo: i.validTo ?? null,
      maxRedemptions: i.maxRedemptions ?? null,
      perCustomerLimit: i.perCustomerLimit ?? null,
      ...trail,
    },
  });
  return { done: `Added ${i.code}`, href: '/promotions', id };
}

async function promotionById(env: Env, id: string) {
  const row = await createDb(env.DB).select().from(promotions).where(eq(promotions.id, id)).get();
  if (!row) throw new Refused('No such promotion.');
  return row;
}

export async function previewPromotionStatus(
  env: Env,
  i: { promotionId: string; status: 'active' | 'paused' },
  roleBlock?: string,
): Promise<ActionPreview> {
  const row = await promotionById(env, i.promotionId);
  return {
    title: `${i.status === 'paused' ? 'Pause' : 'Reactivate'} ${row.code}`,
    href: '/promotions',
    consequences: [
      what(row),
      i.status === 'paused'
        ? 'Carts and checkouts stop accepting it; orders it already discounted keep their price'
        : 'Buyers and staff can enter it again',
    ],
    blocked:
      roleBlock ?? (row.status === i.status ? `${row.code} is already ${i.status}.` : undefined),
  };
}

export async function runPromotionStatus(
  env: Env,
  p: Principal,
  i: { promotionId: string; status: 'active' | 'paused' },
  trail: Trail,
) {
  const row = await promotionById(env, i.promotionId);
  await createDb(env.DB)
    .update(promotions)
    .set({ status: i.status, updatedAt: Date.now() })
    .where(eq(promotions.id, row.id));
  await recordAudit(env, 'promotion.saved', {
    actor: p,
    target: row.id,
    detail: { status: i.status, ...trail },
  });
  return {
    done: `${i.status === 'paused' ? 'Paused' : 'Reactivated'} ${row.code}`,
    href: '/promotions',
    id: row.id,
  };
}

/** The last four characters of a certificate number: enough to tell two apart on a card. */
const lastFour = (n: string) => (n.length > 6 ? `…${n.slice(-4)}` : '(number hidden)');

async function certificateOf(env: Env, customerId: string, certificateId: string) {
  const c = (await customerTaxCertificates(env, customerId)).find((x) => x.id === certificateId);
  if (!c) throw new Refused('No such certificate.');
  return c;
}

const staff = (p: Principal): RpcActor => ({
  kind: 'staff',
  id: p.id,
  name: p.email ?? p.name,
  role: p.role,
});

export async function previewCertificate(
  env: Env,
  p: Principal,
  change: 'verify' | 'revoke',
  i: { customerId: string; certificateId: string },
  roleBlock?: string,
): Promise<ActionPreview> {
  const c = await certificateOf(env, i.customerId, i.certificateId);
  const who = (await customerName(env, i.customerId)) ?? i.customerId;
  const places = c.regions
    .map((r) => (r.region ? `${r.country}-${r.region}` : r.country))
    .join(', ');
  const state = taxCertificateState(c, Date.now());
  return {
    title: `${change === 'verify' ? 'Verify' : 'Revoke'} certificate ${lastFour(c.number)} for ${boundText(who, 80) ?? i.customerId}`,
    href: `/customers/${i.customerId}`,
    consequences:
      change === 'verify'
        ? [
            `Orders this customer starts from now are tax-exempt in ${places}`,
            c.expiresAt
              ? `Until ${new Date(c.expiresAt).toISOString().slice(0, 10)}`
              : 'No expiry date',
            'Orders already running keep the tax they were charged',
          ]
        : [
            `Orders this customer starts from now are taxed again in ${places}`,
            'Orders already running keep the tax they were charged',
          ],
    blocked:
      roleBlock ??
      (c.status === 'revoked'
        ? change === 'verify'
          ? 'The certificate was revoked; add a new one.'
          : 'It is already revoked.'
        : change === 'verify' && c.verifiedAt !== null
          ? 'It is already verified.'
          : change === 'verify' && state === 'expired'
            ? 'The certificate has expired; add the renewed one.'
            : change === 'verify' && p.kind !== 'user'
              ? // An API token's id is its own, never its maker's: separation couldn't tell.
                'A person verifies a certificate, signed in as themselves, not with an API token.'
              : change === 'verify' && c.createdById === p.id && (await separated(env))
                ? 'Someone other than whoever added the certificate must verify it.'
                : undefined),
  };
}

export async function runCertificate(
  env: Env,
  p: Principal,
  change: 'verify' | 'revoke',
  i: { customerId: string; certificateId: string },
  trail: Trail,
) {
  const r =
    change === 'verify'
      ? await verifyTaxCertificate(env, i.customerId, i.certificateId, staff(p))
      : await revokeTaxCertificate(env, i.customerId, i.certificateId, staff(p));
  if (!r.ok) throw new Refused(r.error);
  if (r.value.changed)
    await recordAudit(
      env,
      change === 'verify' ? 'tax_certificate.verified' : 'tax_certificate.revoked',
      {
        actor: p,
        target: i.customerId,
        detail: { certificate: i.certificateId, ...trail },
      },
    );
  return {
    done: `${change === 'verify' ? 'Verified' : 'Revoked'} the certificate`,
    href: `/customers/${i.customerId}`,
    id: i.certificateId,
  };
}
