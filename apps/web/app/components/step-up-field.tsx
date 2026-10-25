import { Input } from '@orderloop/ui/input';
import { Field } from '~/components/inspector';
import type { StepUpMethod } from '~/lib/auth.server';

/**
 * What proves it's the admin before a sensitive change (`stepUp`): the field their sign-in asks
 * for. Someone with only single sign-on confirms at the provider, which brings them back to `next`.
 */
export function StepUpField({ method, next }: { method: StepUpMethod | null; next: string }) {
  if (method === 'code')
    return (
      <Field label="Code from your authenticator app">
        <Input
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          required
          className="w-32"
        />
      </Field>
    );
  if (method === 'password')
    return (
      <Field label="Your password">
        <Input name="password" type="password" autoComplete="current-password" required />
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
