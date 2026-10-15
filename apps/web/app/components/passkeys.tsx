/**
 * The Account page's passkeys: the person's list, adding one (after their password, then the
 * browser's own prompt) and removing one (after their password). Talks to `/account/passkeys`.
 */

import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { browserSupportsWebAuthn, startRegistration } from '@simplewebauthn/browser';
import { useEffect, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import { Ago } from '~/components/ago';
import { Section } from '~/components/page';

export type PasskeyRow = {
  id: string;
  name: string;
  backedUp: boolean;
  createdAt: number;
  lastUsedAt: number | null;
};

async function post(body: Record<string, unknown>) {
  const res = await fetch('/account/passkeys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json.error ?? 'That did not go through. Try again.'));
  return json;
}

/** The browser's refusal in words: most mean the person closed its prompt. */
function browserError(err: unknown): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError')
    return 'The passkey prompt was closed before it finished. Nothing was added.';
  if (name === 'InvalidStateError') return 'This device already has a passkey for your account.';
  return err instanceof Error ? err.message : String(err);
}

export function Passkeys({ passkeys }: { passkeys: PasskeyRow[] }) {
  const revalidator = useRevalidator();
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(browserSupportsWebAuthn()), []);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const statusLine = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (said) statusLine.current?.focus();
  }, [said]);

  const add = async (form: HTMLFormElement) => {
    const f = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      const { options } = await post({ step: 'options', password: f.get('password') });
      let response: Awaited<ReturnType<typeof startRegistration>>;
      try {
        response = await startRegistration({
          optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'],
        });
      } catch (err) {
        throw new Error(browserError(err));
      }
      await post({ step: 'add', response, name: f.get('name') });
      setAdding(false);
      setSaid('Passkey added. Use it on the sign-in page.');
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (form: HTMLFormElement, id: string, name: string) => {
    setBusy(true);
    setError(null);
    try {
      await post({ step: 'remove', id, password: new FormData(form).get('password') });
      setRemoving(null);
      setSaid(`Removed “${name}”. It no longer signs you in.`);
      revalidator.revalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const passwordField = (id: string) => (
    <label className="block text-sm" htmlFor={id}>
      Your password
      <Input
        id={id}
        name="password"
        type="password"
        required
        autoComplete="current-password"
        className="mt-1"
      />
    </label>
  );
  const errorLine = error ? (
    <p role="alert" className="text-destructive text-sm">
      {error}
    </p>
  ) : null;

  return (
    <Section title="Passkeys" className="mt-6">
      <div className="space-y-4">
        <p className="text-muted-foreground text-sm">
          Sign in with your fingerprint, face or device PIN instead of your password and code. A
          passkey stays on your device or password manager; OrderLoop keeps only its public key.
        </p>
        {said ? (
          <p ref={statusLine} tabIndex={-1} role="status" className="text-sm outline-none">
            {said}
          </p>
        ) : null}
        {passkeys.length ? (
          <ul className="divide-y rounded-sm border text-sm">
            {passkeys.map((p) => (
              <li key={p.id} className="p-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium">{p.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {p.backedUp ? 'synced' : 'this device only'} · added <Ago ms={p.createdAt} />
                    {p.lastUsedAt ? (
                      <>
                        {' '}
                        · used <Ago ms={p.lastUsedAt} />
                      </>
                    ) : null}
                  </span>
                  {removing === p.id ? null : (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="ml-auto"
                      onClick={() => {
                        setRemoving(p.id);
                        setAdding(false);
                        setError(null);
                      }}
                    >
                      Remove
                    </Button>
                  )}
                </div>
                {removing === p.id ? (
                  <form
                    className="mt-3 space-y-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void remove(e.currentTarget, p.id, p.name);
                    }}
                  >
                    {passwordField(`remove-${p.id}`)}
                    {errorLine}
                    <div className="flex gap-2">
                      <Button type="submit" size="sm" variant="destructive" disabled={busy}>
                        {busy ? 'Removing…' : 'Remove passkey'}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => setRemoving(null)}
                      >
                        Keep it
                      </Button>
                    </div>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
        {!supported ? (
          <p className="text-muted-foreground text-sm">This browser can’t create passkeys.</p>
        ) : adding ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void add(e.currentTarget);
            }}
          >
            <label className="block text-sm" htmlFor="passkey-name">
              Name <span className="text-muted-foreground">(optional)</span>
              <Input
                id="passkey-name"
                name="name"
                maxLength={60}
                placeholder="e.g. Work laptop"
                className="mt-1"
              />
            </label>
            {passwordField('passkey-password')}
            {errorLine}
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? 'Waiting for your device…' : 'Continue'}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setAdding(true);
              setRemoving(null);
              setError(null);
              setSaid(null);
            }}
          >
            Add a passkey
          </Button>
        )}
      </div>
    </Section>
  );
}
