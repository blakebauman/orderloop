import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { Form, redirect, useActionData } from 'react-router';
import { Mark } from '~/components/mark';
import { signIn } from '~/lib/auth.server';
import type { Route } from './+types/login';

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const cookie = await signIn(String(form.get('password') ?? ''));
  if (!cookie) return { error: 'That password is not right. Check it and try again.' };
  const next = new URL(request.url).searchParams.get('next');
  const safe = next?.startsWith('/') && !next.startsWith('//') ? next : '/';
  return redirect(safe, { headers: { 'set-cookie': cookie } });
}

export default function Login() {
  const data = useActionData<typeof action>();
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <Form method="post" className="w-full max-w-sm rounded-md border bg-card p-6">
        <Mark className="size-7" />
        <h1 className="mt-4 font-semibold font-serif text-2xl">Order Loop</h1>
        <p className="mt-1 text-muted-foreground text-sm">Enter the workspace password.</p>
        <Input
          name="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          className="mt-5"
          aria-label="Password"
          aria-invalid={data?.error ? true : undefined}
        />
        {data?.error ? (
          <p className="mt-2 text-destructive text-sm" role="alert">
            {data.error}
          </p>
        ) : null}
        <Button type="submit" className="mt-4 w-full">
          Sign in
        </Button>
      </Form>
    </main>
  );
}
