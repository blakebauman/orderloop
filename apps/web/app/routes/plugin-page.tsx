/**
 * A plugin's page drawn by the app: the plugin answered with a view (`PluginView`) and the web
 * Worker checked it and handed it here in the load context (app/lib/plugin-view.ts), so the page
 * has the app's shell, components and theme while the plugin only sent data. Links and forms are
 * ordinary document requests to the plugin's own pages; nothing here talks to a plugin.
 */

import {
  type CheckedPluginView,
  type PluginViewBlock,
  type PluginViewCell,
  type PluginViewForm,
  pluginViewHref,
} from '@orderloop/core';
import { Alert, AlertDescription, AlertTitle } from '@orderloop/ui/alert';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Textarea } from '@orderloop/ui/textarea';
import { useId } from 'react';
import { data, useLoaderData } from 'react-router';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { pluginPageContext } from '~/lib/plugin-view';
import type { Route } from './+types/plugin-page';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.view?.title ?? 'Plugin'} · OrderLoop` },
];

export async function loader({ request, context, params }: Route.LoaderArgs) {
  await requireUser(request);
  const page = context.get(pluginPageContext);
  // Only the Worker renders this route, with the plugin's view; any other way here is a miss.
  if (!page || page.pluginId !== params.pluginId) throw data('Not found', { status: 404 });
  // The plugin's own status, if it is an error; anything else (a 204 or 304 can't carry a page) is a 200.
  const status = page.error ? 502 : page.status >= 400 && page.status <= 599 ? page.status : 200;
  return data({ ...page, base: `/plugins/${page.pluginId}/` }, { status });
}

/** The view arrived with the request that rendered it; there is nothing to fetch again. */
export const shouldRevalidate = () => false;

const TONE: Record<string, string> = {
  default: '',
  muted: 'text-muted-foreground',
  ok: 'text-ok',
  warning: 'text-wait',
  bad: 'text-bad',
};

export default function PluginPage() {
  const { view, error, base, pluginId } = useLoaderData<typeof loader>();
  if (!view)
    return (
      <>
        <PageHeader title="This page can't be shown" />
        <Body>
          <Alert variant="destructive">
            <AlertTitle>The {pluginId} plugin answered with a page OrderLoop can't draw</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </Body>
      </>
    );
  return <View view={view} base={base} />;
}

function View({ view, base }: { view: CheckedPluginView; base: string }) {
  const href = (t: string) => pluginViewHref(base, t) ?? base;
  return (
    <>
      <PageHeader
        title={view.title}
        subtitle={view.description}
        actions={view.actions?.map((a) => (
          <Button key={a.href} asChild variant="outline" size="sm">
            <a href={href(a.href)}>{a.label}</a>
          </Button>
        ))}
      />
      <Body className="grid gap-4">
        {view.blocks.map((b, i) =>
          b.type === 'section' ? (
            <Section key={`${b.title}-${i}`} title={b.title}>
              {b.description ? (
                <p className="mb-3 text-muted-foreground text-sm">{b.description}</p>
              ) : null}
              <div className="grid gap-4">
                {b.blocks.map((x, j) => (
                  <Block key={`${x.type}-${j}`} block={x} base={base} />
                ))}
              </div>
            </Section>
          ) : (
            <Block key={`${b.type}-${i}`} block={b} base={base} />
          ),
        )}
      </Body>
    </>
  );
}

type Leaf = Exclude<PluginViewBlock, { type: 'section' }>;

function Block({ block: b, base }: { block: Leaf; base: string }) {
  const href = (t: string) => pluginViewHref(base, t) ?? base;
  switch (b.type) {
    case 'text':
      return <p className={cn('max-w-[75ch] text-sm', TONE[b.tone])}>{b.text}</p>;
    case 'alert':
      return (
        <Alert variant={b.tone === 'error' ? 'destructive' : 'default'}>
          {b.title ? <AlertTitle>{b.title}</AlertTitle> : null}
          <AlertDescription>{b.text}</AlertDescription>
        </Alert>
      );
    case 'stats':
      return (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {b.items.map((s) => (
            <div key={s.label} className="rounded-md border bg-card px-3 py-2">
              <dt className="caption">{s.label}</dt>
              <dd className="font-semibold text-lg tabular-nums">{s.value}</dd>
              {s.hint ? <dd className="text-muted-foreground text-xs">{s.hint}</dd> : null}
            </div>
          ))}
        </dl>
      );
    case 'table':
      return b.rows.length ? (
        <div className="overflow-x-auto rounded-md border bg-card">
          <table className="w-full text-sm">
            <thead className="border-b text-left">
              <tr>
                {b.columns.map((c) => (
                  <th
                    key={c.key}
                    className={cn(
                      'caption px-3 py-2 font-normal',
                      c.align === 'right' && 'text-right',
                    )}
                  >
                    {c.label}
                  </th>
                ))}
                {b.rows.some((r) => r.actions?.length) ? <th className="w-0" /> : null}
              </tr>
            </thead>
            <tbody className="divide-y">
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {b.columns.map((c) => (
                    <td
                      key={c.key}
                      className={cn(
                        'px-3 py-2 align-top',
                        c.align === 'right' && 'text-right tabular-nums',
                      )}
                    >
                      <Cell cell={r.cells[c.key]} href={href} />
                    </td>
                  ))}
                  {r.actions?.length ? (
                    <td className="px-2 py-1.5 text-right">
                      <div className="flex justify-end gap-1">
                        {r.actions.map((a) => (
                          <FormBlock key={`${a.action}-${a.submit}`} form={a} href={href} inline />
                        ))}
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-md border bg-card">
          <Empty>{b.empty ?? 'Nothing here yet.'}</Empty>
        </div>
      );
    case 'form':
      return <FormBlock form={b} href={href} />;
    case 'code':
      return (
        <div className="grid gap-1">
          {b.label ? <span className="caption">{b.label}</span> : null}
          <pre className="overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-sm">
            {b.text}
          </pre>
        </div>
      );
    case 'list':
      return (
        <ul className="grid list-disc gap-1 pl-5 text-sm">
          {b.items.map((it, i) =>
            typeof it === 'string' ? (
              <li key={i}>{it}</li>
            ) : (
              <li key={it.href}>
                <a href={href(it.href)} className="text-link hover:underline">
                  {it.label}
                </a>
              </li>
            ),
          )}
        </ul>
      );
  }
}

function Cell({ cell, href }: { cell: PluginViewCell | undefined; href: (t: string) => string }) {
  if (cell === undefined) return null;
  if (typeof cell !== 'object') return <>{cell}</>;
  const body = (
    <span className={cn(cell.mono && 'font-mono text-xs', TONE[cell.tone ?? 'default'])}>
      {cell.text}
    </span>
  );
  return cell.href ? (
    <a href={href(cell.href)} className="text-link hover:underline">
      {body}
    </a>
  ) : (
    body
  );
}

/** An ordinary form post to the plugin's page; the reply is the next page, drawn the same way. */
function FormBlock({
  form,
  href,
  inline = false,
}: {
  form: PluginViewForm;
  href: (t: string) => string;
  inline?: boolean;
}) {
  const id = useId();
  const visible = form.fields.filter((f) => f.kind !== 'hidden');
  return (
    <form
      method="post"
      action={href(form.action)}
      className={inline ? 'inline' : 'grid max-w-xl gap-3 rounded-md border bg-card p-4'}
      onSubmit={(e) => {
        if (form.confirm && !window.confirm(form.confirm)) e.preventDefault();
      }}
    >
      {form.fields
        .filter((f) => f.kind === 'hidden')
        .map((f) => (
          <input key={f.name} type="hidden" name={f.name} value={String(f.value ?? '')} />
        ))}
      {visible.map((f) => {
        const fid = `${id}-${f.name}`;
        const value = f.value === undefined ? undefined : String(f.value);
        return (
          <div
            key={f.name}
            className={f.kind === 'checkbox' ? 'flex items-center gap-2' : 'grid gap-1'}
          >
            {f.kind === 'checkbox' ? (
              <input
                id={fid}
                type="checkbox"
                name={f.name}
                value="on"
                defaultChecked={f.value === true || f.value === 'on'}
              />
            ) : null}
            <label htmlFor={fid} className={f.kind === 'checkbox' ? 'text-sm' : 'caption'}>
              {f.label}
            </label>
            {f.kind === 'textarea' ? (
              <Textarea
                id={fid}
                name={f.name}
                defaultValue={value}
                required={f.required}
                placeholder={f.placeholder}
              />
            ) : f.kind === 'select' ? (
              <NativeSelect
                id={fid}
                name={f.name}
                defaultValue={value}
                required={f.required}
                className="h-8"
              >
                {(f.options ?? []).map((o) => (
                  <NativeSelectOption key={o.value} value={o.value}>
                    {o.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : f.kind === 'checkbox' ? null : (
              <Input
                id={fid}
                name={f.name}
                type={f.kind}
                defaultValue={value}
                required={f.required}
                placeholder={f.placeholder}
                // A password manager shouldn't offer this app's sign-in on a plugin's form.
                autoComplete={f.kind === 'password' ? 'new-password' : 'off'}
                className="h-8"
              />
            )}
            {f.hint ? <p className="text-muted-foreground text-xs">{f.hint}</p> : null}
          </div>
        );
      })}
      <div>
        <Button
          type="submit"
          size="sm"
          variant={form.tone === 'danger' ? 'destructive' : inline ? 'ghost' : 'default'}
        >
          {form.submit}
        </Button>
      </div>
    </form>
  );
}
