import { Field, FieldLabel } from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import { useId } from 'react';
import type { StepUpMethod } from '~/lib/auth.server';

/**
 * What proves it's the admin before a sensitive change (`stepUp`): the field their sign-in asks
 * for. Someone with only single sign-on confirms at the provider, which brings them back to `next`.
 * `w-auto` so it sits in a row beside a confirming button as well as in a form's column.
 */
export function StepUpField({ method, next }: { method: StepUpMethod | null; next: string }) {
  const id = useId();
  if (method === 'code')
    return (
      <Field className="w-auto min-w-0 gap-1.5">
        <FieldLabel htmlFor={id}>Code from your authenticator app</FieldLabel>
        <Input
          id={id}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
          className="max-w-32"
        />
      </Field>
    );
  if (method === 'password')
    return (
      <Field className="w-auto min-w-0 gap-1.5">
        <FieldLabel htmlFor={id}>Your password</FieldLabel>
        <Input id={id} name="password" type="password" autoComplete="current-password" required />
      </Field>
    );
  if (method === null) return null;
  // A plain link: the provider's sign-in is a top-level GET, and it brings them back here.
  return (
    <p className="text-muted-foreground text-xs">
      You sign in with single sign-on:{' '}
      <a
        href={`/login/sso?reauth=1&next=${encodeURIComponent(next)}`}
        className="text-link hover:underline"
      >
        confirm it’s you
      </a>
      , then do this within ten minutes.
    </p>
  );
}
