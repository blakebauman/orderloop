/**
 * A partner's self-test, from its admin page: whether a session from its system would be let in
 * and open a cart, checked without one. The record is checked here; whether the core would open its
 * cart (its flow, its customer, where the cart goes back) is asked of `checkExternalCart`, which
 * opens nothing. It reads only: no cart, order, session or webhook, and it never needs the secret.
 */

import { MAX_FRAME_ORIGINS, ORDER_MODELS } from '@orderloop/core';
import { host } from '@orderloop/plugin-sdk';
import { cartInput, type Partner, PROTOCOLS } from './partners';

export type Check = { label: string; ok: boolean; detail: string };

const list = (xs: string[]) => xs.join(', ');

/** Whether `raw` is a bare host name, as a return URL's host is compared with it. */
const hostName = (raw: string) => {
  try {
    const u = new URL(`https://${raw}/`);
    return /^[a-z0-9.-]+$/.test(raw) && u.hostname === raw && u.host === raw;
  } catch {
    return false;
  }
};

/** Whether `raw` is an https origin, written as the core compares it. */
const httpsOrigin = (raw: string) => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.origin === raw;
  } catch {
    return false;
  }
};

function recordChecks(p: Partner): Check[] {
  const missing = [
    !p.name && 'name',
    !PROTOCOLS.includes(p.protocol) && 'protocol',
    p.protocol === 'cxml' && !p.fromDomain && 'From domain',
    !p.identity && (p.protocol === 'oci' ? 'USERNAME' : 'identity'),
    p.protocol === 'cxml' && !(p.supplierDomain && p.supplierIdentity) && 'our credential',
    !p.flowId && 'flow',
    !p.returnHosts.length && 'return hosts',
    !/^[0-9a-f]{64}$/.test(p.secretHash) && 'secret',
    !(Number.isInteger(p.sessionMinutes) && p.sessionMinutes >= 5 && p.sessionMinutes <= 24 * 60) &&
      'idle timeout',
  ].filter((m): m is string => !!m);
  const badHosts = p.returnHosts.filter((h) => !hostName(h));
  const badOrigins = p.frameOrigins.filter((o) => !httpsOrigin(o));
  return [
    {
      label: 'Partner record',
      ok: !missing.length,
      detail: missing.length
        ? `Missing or invalid: ${list(missing)}. Add the partner again with them.`
        : 'Its credentials, flow, return hosts, secret and idle timeout are set.',
    },
    {
      label: 'Return hosts',
      ok: p.returnHosts.length > 0 && !badHosts.length,
      detail: badHosts.length
        ? `Not host names: ${list(badHosts)}.`
        : p.returnHosts.length
          ? `Carts go back only over https to ${list(p.returnHosts)}.`
          : 'None listed, so no cart can go back.',
    },
    {
      label: 'Frame origins',
      ok: !badOrigins.length && p.frameOrigins.length <= MAX_FRAME_ORIGINS,
      detail: badOrigins.length
        ? `Not https origins: ${list(badOrigins)}.`
        : p.frameOrigins.length > MAX_FRAME_ORIGINS
          ? `At most ${MAX_FRAME_ORIGINS}.`
          : p.frameOrigins.length
            ? `The catalog may be shown inside ${list(p.frameOrigins)}.`
            : 'None: the catalog can’t be shown inside their system’s page, only in its own window.',
    },
    {
      label: 'Status',
      ok: p.status === 'active',
      detail:
        p.status === 'active'
          ? 'Active: it may open sessions and send orders.'
          : 'Disabled: its sessions and orders are refused. Enable it to use it.',
    },
    {
      label: 'Commerce model',
      ok: (ORDER_MODELS as readonly string[]).includes(p.model),
      detail: (ORDER_MODELS as readonly string[]).includes(p.model)
        ? `Its orders start as ${p.model}.`
        : `“${p.model}” isn’t a commerce model, so its orders would be refused.`,
    },
  ];
}

/** What the core says of the carts it would open, one check each for the cart, flow and customer. */
async function coreChecks(env: Env, p: Partner): Promise<Check[]> {
  const labels = ['Cart', 'Flow', 'Customer'];
  const all = (detail: string) => labels.map((label) => ({ label, ok: false, detail }));
  // One cart per return host, as a session returning to it would ask for one.
  const hosts = p.returnHosts.filter(hostName).slice(0, 20);
  if (!hosts.length) return all('Not checked: the partner has no usable return host.');
  const ungranted = all(
    'Not checked: this deployment doesn’t let Punchout open carts. Ask whoever runs it to grant it.',
  );
  if (!env.ORDERLOOP) return ungranted;
  let answers: Awaited<ReturnType<ReturnType<typeof host>['checkExternalCart']>>[];
  try {
    answers = await Promise.all(
      hosts.map((h) =>
        host(env).checkExternalCart(
          cartInput(p, {
            sessionRef: `${p.id}:self-test`,
            buyer: { id: 'self-test', name: 'Partner test' },
            returnUrl: `https://${h}/`,
          }),
        ),
      ),
    );
  } catch {
    return all('Not checked: OrderLoop couldn’t be reached. Try again.');
  }
  const refused = answers.find((a) => !a.ok);
  if (refused || !answers[0]?.ok) return ungranted;
  const problems = answers.flatMap((a) => (a.ok ? [a.problems] : []));
  const inputProblems = [...new Set(problems.map((x) => x.input).filter((x) => x !== null))];
  const { flow, customer } = problems[0]!;
  return [
    {
      label: 'Cart',
      ok: !inputProblems.length,
      detail: inputProblems.length
        ? inputProblems.join(' ')
        : 'OrderLoop accepts the cart a session would open, returning to each host.',
    },
    {
      label: 'Flow',
      ok: !flow,
      detail: flow ? `${p.flowId}: ${flow}` : `${p.flowId} is published and prices its carts.`,
    },
    {
      label: 'Customer',
      ok: !customer,
      detail: customer
        ? `${p.customerId}: ${customer}`
        : p.customerId
          ? `Carts and orders are for ${p.customerId}, at its contract prices.`
          : 'None: its carts and orders aren’t for a customer.',
    },
  ];
}

/** Every check, in the order the page lists them. */
export async function testPartner(env: Env, p: Partner): Promise<Check[]> {
  return [...recordChecks(p), ...(await coreChecks(env, p))];
}
