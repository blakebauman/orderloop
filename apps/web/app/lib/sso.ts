/**
 * Single sign-on rules, without bindings: the workspace's SSO settings and who an identity from the
 * identity provider signs in as. `sso.server.ts` runs the OpenID Connect flow around them.
 */

import { isRole, type Role } from '@orderloop/core';

/**
 * What admins choose on the Team page. `jitRole` adds someone the identity provider vouches for,
 * on their first sign-in, with that role (null: only people already on the team). `domains` are
 * the email domains SSO accepts for that. `ssoOnly` turns off passwords and passkeys.
 */
export type SsoSettings = { jitRole: Role | null; domains: string[]; ssoOnly: boolean };

export const DEFAULT_SSO: SsoSettings = { jitRole: null, domains: [], ssoOnly: false };

const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** Domains from an admin's text: comma- or line-separated, `@` and case ignored, invalid dropped. */
export function parseDomains(text: string): string[] {
  const out = text
    .split(/[\s,]+/)
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter((d) => DOMAIN.test(d));
  return [...new Set(out)].slice(0, 50);
}

/** Settings as stored (JSON in `workspace_settings`), with anything unreadable at its default. */
export function readSsoSettings(raw: string | null | undefined): SsoSettings {
  if (!raw) return DEFAULT_SSO;
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof SsoSettings, unknown>>;
    return {
      // Never admin: an identity no one here has seen joins as at most an operator.
      jitRole: isRole(v.jitRole) && v.jitRole !== 'admin' ? v.jitRole : null,
      domains: Array.isArray(v.domains) ? parseDomains(v.domains.join(',')) : [],
      ssoOnly: v.ssoOnly === true,
    };
  } catch {
    return DEFAULT_SSO;
  }
}

/** The domain part of an email, lower-cased. */
export const emailDomain = (email: string) => email.slice(email.lastIndexOf('@') + 1).toLowerCase();

/** What the identity provider said about the person, from a verified ID token. */
export type SsoIdentity = { sub: string; email: string | null; name: string | null };

type Known = { id: string; externalSub: string | null; disabledAt: number | null };

/**
 * Who an identity signs in as:
 * - the person already linked to its subject;
 * - else the person with its (verified) email, who gets linked to it;
 * - else, when admins allow it and the email's domain is on the list, a new person.
 * Disabled people, and an email already linked to another subject, are refused.
 */
export function decideSso(
  id: SsoIdentity,
  bySub: Known | undefined,
  byEmail: Known | undefined,
  settings: SsoSettings,
):
  | { kind: 'existing'; userId: string }
  | { kind: 'link'; userId: string }
  | { kind: 'create'; role: Role; email: string }
  | { kind: 'refuse'; reason: string } {
  if (bySub)
    return bySub.disabledAt
      ? { kind: 'refuse', reason: 'disabled' }
      : { kind: 'existing', userId: bySub.id };
  if (!id.email) return { kind: 'refuse', reason: 'no verified email' };
  if (byEmail) {
    if (byEmail.disabledAt) return { kind: 'refuse', reason: 'disabled' };
    if (byEmail.externalSub) return { kind: 'refuse', reason: 'email linked to another identity' };
    return { kind: 'link', userId: byEmail.id };
  }
  if (!settings.jitRole) return { kind: 'refuse', reason: 'not on the team' };
  if (!settings.domains.includes(emailDomain(id.email)))
    return { kind: 'refuse', reason: 'domain not allowed' };
  return { kind: 'create', role: settings.jitRole, email: id.email };
}

/** The settings in a few words, for the audit log. */
export function describeSso(raw: unknown): string {
  const s = readSsoSettings(JSON.stringify(raw ?? null));
  const joining = s.jitRole
    ? `new people join as ${s.jitRole} from ${s.domains.join(', ') || 'no domains'}`
    : 'only people on the team';
  return `${joining}; ${s.ssoOnly ? 'SSO only' : 'passwords allowed'}`;
}
