import {
  ASSISTANT_PUBLISHER,
  CATEGORY_LABELS,
  type PluginCaseResult,
  type PluginInstallView,
  type PluginManifest,
  type PluginRuntime,
  PROVIDER_SURFACE_LABELS,
  pluginSecretVar,
  ROLE_LABELS,
} from '@orderloop/core';
import { users } from '@orderloop/db';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { inArray } from 'drizzle-orm';
import { data, Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { Ago } from '~/components/ago';
import { Field } from '~/components/inspector';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { StatusDot } from '~/components/status';
import { requireUser, type StepUpMethod, stepUpMethod } from '~/lib/auth.server';
import { BodyTooLarge, readText } from '~/lib/body';
import { db, engine } from '~/lib/env.server';
import { PLUGIN_FORM_MAX_BYTES, pluginAction } from '~/lib/plugin-installs.server';
import { listDeliveries, listPluginErrors } from '~/lib/webhooks.server';
import type { Route } from './+types/plugins';

export const meta = () => [{ title: 'Plugins · OrderLoop' }];

const RECENT = 10;

export async function loader({ request }: Route.LoaderArgs) {
  const me = await requireUser(request, 'admin');
  const [statuses, installs, stepUp] = await Promise.all([
    engine().pluginCatalog(),
    engine().listPluginInstalls(),
    stepUpMethod(me),
  ]);
  const plugins = await Promise.all(
    statuses.map(async (s) => {
      // A refused plugin has no manifest, but its id is known: that is when its flows and
      // running orders matter most.
      const id = s.id;
      const [usage, deliveries, errors] = await Promise.all([
        engine().pluginUsage(id),
        listDeliveries(`plugin:${id}`, RECENT),
        s.runtime === 'sandboxed' ? listPluginErrors(id, RECENT) : Promise.resolve([]),
      ]);
      return {
        ...s,
        usage,
        errors: errors.map((e) => ({ id: e.id, message: e.message, at: e.at })),
        deliveries: deliveries.map((d) => ({
          id: d.id,
          event: d.event,
          orderId: d.orderId,
          status: d.status,
          attempts: d.attempts,
          lastError: d.lastError,
          createdAt: d.createdAt,
        })),
      };
    }),
  );
  const shown = installs.filter((i) => i.status !== 'uninstalled');
  // Who uploaded each (or asked the assistant for it), by name.
  const ids = [...new Set(shown.map((i) => i.uploadedBy))];
  const people = ids.length
    ? await db()
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const names = Object.fromEntries(people.map((u) => [u.id, u.name]));
  return { plugins, installs: shown, stepUp, names };
}

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'admin');
  let form: FormData;
  try {
    // Capped before it is parsed: a bundle is at most PLUGIN_BUNDLE_MAX_BYTES.
    const text = await readText(request, PLUGIN_FORM_MAX_BYTES);
    form = await new Response(text, {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();
  } catch (err) {
    if (err instanceof BodyTooLarge)
      return data({ ok: false as const, error: 'That file is too large for a plugin.' }, 413);
    return data({ ok: false as const, error: 'That form could not be read.' }, 400);
  }
  const r = await pluginAction(request, me, form);
  return r.ok ? r : data(r, 400);
}

export default function Plugins() {
  const { plugins, installs, stepUp, names } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const pending = installs.filter((i) => i.status === 'pending');
  // A plugin turned off is out of the catalog, but still installed: it keeps its controls.
  const off = installs.filter(
    (i) => i.status === 'disabled' && !plugins.some((p) => p.id === i.id),
  );
  return (
    <>
      <PageHeader
        title="Plugins"
        subtitle="Optional features on this workspace, each running on its own. What they add to flows, what they are sent, and whether they are answering. Install one from a file signed by a publisher this workspace trusts."
      />
      <Body className="space-y-4">
        {result ? (
          <p
            role={result.ok ? 'status' : 'alert'}
            className={result.ok ? 'text-sm' : 'text-destructive text-sm'}
          >
            {result.ok ? result.done : result.error}
          </p>
        ) : null}
        <Upload />
        {pending.map((i) => (
          <Review key={i.sha} install={i} stepUp={stepUp} by={names[i.uploadedBy]} />
        ))}
        {plugins.length || off.length ? (
          <>
            {plugins.map((p) => (
              <PluginSection
                key={p.id}
                plugin={p}
                installs={installs.filter((i) => i.id === p.id)}
                stepUp={stepUp}
              />
            ))}
            {off.map((i) => (
              <Section
                key={i.id}
                title={
                  <>
                    {i.manifest.name}{' '}
                    <span className="font-normal text-muted-foreground text-xs">
                      {i.id} · version {i.version}
                    </span>
                  </>
                }
                actions={
                  <span className="flex items-center gap-1.5 text-sm">
                    <StatusDot status="cancelled" />
                    Off
                  </span>
                }
              >
                <ManifestDetails m={i.manifest} runtime="sandboxed" secrets={i.secrets} />
                <InstallControls installs={installs.filter((x) => x.id === i.id)} stepUp={stepUp} />
              </Section>
            ))}
          </>
        ) : (
          <Section title="Installed">
            <Empty>No plugins are installed on this workspace.</Empty>
          </Section>
        )}
      </Body>
    </>
  );
}

const busyWith = (state: ReturnType<typeof useNavigation>, intent: string, key: string) =>
  state.state !== 'idle' &&
  state.formData?.get('intent') === intent &&
  (state.formData.get('sha') ?? state.formData.get('id')) === key;

function Upload() {
  const nav = useNavigation();
  const busy = nav.state !== 'idle' && nav.formData?.get('intent') === 'upload';
  return (
    <Section title="Install from a file">
      <Form method="post" encType="multipart/form-data" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="intent" value="upload" />
        <Field
          label="Plugin file"
          hint="A .olplugin signed by a publisher this workspace trusts. Nothing runs until you approve it."
        >
          <Input type="file" name="bundle" accept=".olplugin,application/json" required />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? 'Checking…' : 'Upload for review'}
        </Button>
      </Form>
    </Section>
  );
}

/** What proves it's the admin before a change to what runs: the field their sign-in asks for. */
function StepUpField({ method }: { method: StepUpMethod | null }) {
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
  return (
    <p className="text-muted-foreground text-xs">
      You signed in with single sign-on: this works within ten minutes of signing in.
    </p>
  );
}

function SecretForm({
  id,
  name,
  set,
  stepUp,
}: {
  id: string;
  name: string;
  set: boolean;
  /** For a plugin that runs: changing its credentials asks who it is first. */
  stepUp?: StepUpMethod | null;
}) {
  return (
    <Form method="post" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="intent" value="secret" />
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="name" value={name} />
      <Field label={name} hint={set ? 'Set. Enter a new value to replace it.' : 'Not set'}>
        <Input
          name="value"
          type="password"
          autoComplete="off"
          required
          maxLength={4096}
          className="w-64"
        />
      </Field>
      {stepUp !== undefined ? <StepUpField method={stepUp} /> : null}
      <Button type="submit" size="sm" variant="outline">
        {set ? 'Replace' : 'Set'}
      </Button>
    </Form>
  );
}

function Review({
  install: i,
  stepUp,
  by,
}: {
  install: PluginInstallView;
  stepUp: StepUpMethod | null;
  /** Who uploaded it, or asked the assistant for it. */
  by?: string;
}) {
  const nav = useNavigation();
  const m = i.manifest;
  const missing = m.secrets.filter(
    (s) => !s.optional && !i.secrets.find((x) => x.name === s.name)?.set,
  );
  const drafted = i.publisher === ASSISTANT_PUBLISHER;
  const failing =
    drafted &&
    (!i.cases?.length ||
      i.cases.some((c) => !c.pass) ||
      m.nodes.some((n) => !i.cases?.some((c) => `${i.id}.${c.node}` === n.type)));
  return (
    <Section
      id={i.id}
      title={
        <>
          Review {m.name}{' '}
          <span className="font-normal text-muted-foreground text-xs">
            {i.id} · version {i.version} · {i.sha.slice(0, 12)}
          </span>
        </>
      }
      actions={
        <span className="text-muted-foreground text-sm">
          {drafted
            ? `Drafted by the assistant for ${by ?? 'an admin'}`
            : `Signed by ${i.publisher}`}{' '}
          · {drafted ? 'drafted' : `uploaded${by ? ` by ${by}` : ''}`} <Ago ms={i.uploadedAt} />
        </span>
      }
    >
      <p className="mb-3 text-sm">
        Not running yet. Check what it adds and what it reaches before you approve it: once
        approved, it runs on every order whose flow uses it.
      </p>
      {drafted && i.request ? (
        <p className="mb-3 text-sm">
          Asked for: <q>{i.request}</q>
        </p>
      ) : null}
      {drafted ? (
        <p className="mb-3 text-muted-foreground text-sm">
          The assistant wrote this code. Its test cases show what it does on the orders they
          describe, not that it is safe: read the code before you approve it.
        </p>
      ) : null}
      <ManifestDetails m={m} runtime="sandboxed" secrets={i.secrets} />
      {drafted ? <DraftReview install={i} /> : null}
      {m.secrets.length ? (
        <div className="mt-4 grid gap-3 border-t pt-3">
          <h3 className="caption">Secrets</h3>
          {m.secrets.map((x) => (
            <SecretForm
              key={x.name}
              id={i.id}
              name={x.name}
              set={!!i.secrets.find((s) => s.name === x.name)?.set}
            />
          ))}
        </div>
      ) : null}
      <Form method="post" className="mt-4 flex flex-wrap items-end gap-3 border-t pt-3">
        <input type="hidden" name="intent" value="approve" />
        <input type="hidden" name="id" value={i.id} />
        <input type="hidden" name="sha" value={i.sha} />
        {m.personalData === 'send' ? (
          <label className="flex w-full items-start gap-2 text-sm">
            <input type="checkbox" name="personalData" className="mt-1" />
            <span>
              Send it buyer details (names, emails, addresses).{' '}
              <span className="text-muted-foreground">It doesn’t run without them.</span>
            </span>
          </label>
        ) : null}
        <StepUpField method={stepUp} />
        <Button
          type="submit"
          disabled={missing.length > 0 || failing || busyWith(nav, 'approve', i.sha)}
        >
          Approve and install
        </Button>
        {missing.length ? (
          <span className="text-muted-foreground text-xs">
            Set {missing.map((x) => x.name).join(', ')} first.
          </span>
        ) : failing ? (
          <span className="text-muted-foreground text-xs">
            Every step needs a test case, and every case must pass first.
          </span>
        ) : null}
      </Form>
    </Section>
  );
}

/** The cases as an admin edits them: what each one is, without what it last gave. */
const editableCases = (cases: PluginCaseResult[] | null) =>
  JSON.stringify(
    (cases ?? []).map(({ name, node, order, config, expect }) => ({
      name,
      node,
      order,
      config,
      expect,
    })),
    null,
    2,
  );

/** An assistant draft: its rule code to read, and its test cases to check, edit and run. */
function DraftReview({ install: i }: { install: PluginInstallView }) {
  const nav = useNavigation();
  return (
    <div className="mt-4 grid gap-3 border-t pt-3 text-sm">
      <details>
        <summary className="cursor-pointer">Rule code, as the assistant wrote it</summary>
        <pre className="mt-2 max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
          {i.code ?? 'Not available'}
        </pre>
      </details>
      <div>
        <h3 className="caption mb-1.5">Test cases</h3>
        {i.cases?.length ? (
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-normal">Case</th>
                <th className="py-1 pr-3 font-normal">Step</th>
                <th className="py-1 pr-3 font-normal">Expected</th>
                <th className="py-1 pr-3 font-normal">Got</th>
              </tr>
            </thead>
            <tbody>
              {i.cases.map((c, n) => (
                <tr key={`${c.name}-${n}`} className="border-t">
                  <td className="py-1 pr-3">
                    <StatusDot status={c.pass ? 'completed' : 'failed'} /> {c.name}
                  </td>
                  <td className="py-1 pr-3">
                    <code>{c.node}</code>
                  </td>
                  <td className="py-1 pr-3">{c.expect.branch}</td>
                  <td className={c.pass ? 'py-1 pr-3' : 'py-1 pr-3 text-destructive'}>
                    {c.got.branch ?? c.got.error ?? 'nothing'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-muted-foreground">No cases yet: add at least one below.</p>
        )}
      </div>
      <Form method="post" className="grid gap-2">
        <input type="hidden" name="intent" value="cases" />
        <input type="hidden" name="id" value={i.id} />
        <input type="hidden" name="sha" value={i.sha} />
        <Field
          label="Edit the cases"
          hint="Each case: a name, the step, the order fields that matter (the rest are a one-line US order of 100 USD), its settings, and the branch it must take."
        >
          <textarea
            name="cases"
            defaultValue={editableCases(i.cases)}
            rows={10}
            spellCheck={false}
            className="w-full rounded-md border bg-background p-2 font-mono text-xs"
          />
        </Field>
        <div>
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={busyWith(nav, 'cases', i.sha)}
          >
            Run cases
          </Button>
        </div>
      </Form>
    </div>
  );
}

/** A runtime install's controls: its secrets, off and on, earlier versions, and removing it. */
function InstallControls({
  installs,
  stepUp,
}: {
  installs: PluginInstallView[];
  stepUp: StepUpMethod | null;
}) {
  const current = installs.find((i) => i.status === 'active' || i.status === 'disabled');
  if (!current) return null;
  const earlier = installs.filter((i) => i.status === 'superseded');
  const on = current.status === 'active';
  return (
    <div className="mt-4 grid gap-4 border-t pt-3 text-sm">
      <p className="text-muted-foreground">
        Installed here from a file signed by {current.publisher}
        {current.approvedAt ? (
          <>
            , approved <Ago ms={current.approvedAt} />
          </>
        ) : null}
        {current.personalDataGranted ? '. Sent buyer details.' : '.'}
      </p>
      {current.manifest.secrets.length ? (
        <div className="grid gap-3">
          <h3 className="caption">Secrets</h3>
          {current.secrets.map((x) => (
            <SecretForm key={x.name} id={current.id} name={x.name} set={x.set} stepUp={stepUp} />
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Form method="post" className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="intent" value={on ? 'disable' : 'enable'} />
          <input type="hidden" name="id" value={current.id} />
          {on ? null : <StepUpField method={stepUp} />}
          <Button type="submit" size="sm" variant="outline">
            {on ? 'Turn off' : 'Turn on'}
          </Button>
        </Form>
      </div>
      {earlier.length ? (
        <div className="grid gap-2">
          <h3 className="caption">Earlier versions</h3>
          {earlier.map((v) => (
            <Form key={v.sha} method="post" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="intent" value="rollback" />
              <input type="hidden" name="id" value={v.id} />
              <input type="hidden" name="sha" value={v.sha} />
              <span>
                Version {v.version}{' '}
                <span className="text-muted-foreground text-xs">
                  {v.sha.slice(0, 12)} · uploaded <Ago ms={v.uploadedAt} />
                </span>
              </span>
              <StepUpField method={stepUp} />
              <Button type="submit" size="sm" variant="outline">
                Roll back to {v.version}
              </Button>
            </Form>
          ))}
        </div>
      ) : null}
      <Form method="post" className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="intent" value="uninstall" />
        <input type="hidden" name="id" value={current.id} />
        <StepUpField method={stepUp} />
        <Button type="submit" size="sm" variant="destructive">
          Uninstall
        </Button>
        <span className="text-muted-foreground text-xs">
          Only once nothing uses it. Its secrets and stored data are deleted.
        </span>
      </Form>
    </div>
  );
}

type Plugin = Awaited<ReturnType<typeof loader>>['plugins'][number];

function PluginSection({
  plugin: p,
  installs,
  stepUp,
}: {
  plugin: Plugin;
  installs: PluginInstallView[];
  stepUp: StepUpMethod | null;
}) {
  const m = p.manifest;
  const current = installs.find((i) => i.status === 'active');
  const title = m ? (
    <>
      {m.name}{' '}
      <span className="font-normal text-muted-foreground text-xs">
        {m.id} · version {m.version}
      </span>
    </>
  ) : (
    p.id
  );
  return (
    <Section
      title={title}
      actions={
        <span className="flex items-center gap-1.5 text-sm">
          <StatusDot status={p.healthy ? 'completed' : 'failed'} />
          {p.healthy ? 'Answering' : m ? 'Not answering: running its last manifest' : 'Refused'}
        </span>
      }
    >
      {p.error ? <p className="mb-3 text-destructive text-sm">{p.error}</p> : null}
      {m ? (
        <ManifestDetails
          m={m}
          runtime={p.runtime}
          secrets={p.source === 'installed' ? current?.secrets : undefined}
        />
      ) : null}
      {p.usage ? <Usage usage={p.usage} /> : null}
      {m?.events.length || p.deliveries.length ? <Deliveries deliveries={p.deliveries} /> : null}
      {p.errors.length ? <Errors errors={p.errors} /> : null}
      {p.source === 'installed' ? <InstallControls installs={installs} stepUp={stepUp} /> : null}
    </Section>
  );
}

/** What a plugin adds and reaches. `secrets`, for a runtime install, says which are set. */
function ManifestDetails({
  m,
  runtime,
  secrets,
}: {
  m: PluginManifest;
  runtime: PluginRuntime;
  secrets?: { name: string; set: boolean }[];
}) {
  return (
    <div className="grid gap-4 text-sm md:grid-cols-2">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted-foreground">Contract</dt>
        <dd className="tabular">v{m.apiVersion}</dd>
        <dt className="text-muted-foreground">Runs</dt>
        <dd>
          {runtime === 'sandboxed' ? 'Sandboxed in the engine' : 'As its own Worker'}
          {runtime === 'sandboxed' ? (
            <span className="block text-muted-foreground text-xs">
              Reaches {m.egress.length ? m.egress.join(', ') : 'no outside hosts'}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Buyer details</dt>
        <dd>{m.personalData === 'send' ? 'Sent to the plugin' : 'Redacted'}</dd>
        <dt className="text-muted-foreground">Pages</dt>
        <dd>
          {m.nav.length
            ? `${ROLE_LABELS[m.pageRole]} and above`
            : m.publicPaths.length
              ? 'Public endpoints only'
              : 'None'}
          {m.publicPaths.length ? (
            <span className="block text-muted-foreground text-xs">
              Public: {m.publicPaths.join(', ')}
            </span>
          ) : null}
        </dd>
        <dt className="text-muted-foreground">Events</dt>
        <dd>{m.events.length ? m.events.join(', ') : 'None'}</dd>
        {m.provides.length ? (
          <>
            <dt className="text-muted-foreground">Provides</dt>
            <dd>{m.provides.map((x) => PROVIDER_SURFACE_LABELS[x]).join(', ')}</dd>
          </>
        ) : null}
        {m.secrets.length ? (
          <>
            <dt className="text-muted-foreground">Secrets</dt>
            <dd>
              {m.secrets.map((x) => (
                <span key={x.name} className="block">
                  {secrets ? (
                    <>
                      <code className="text-xs">{x.name}</code>
                      <span className="text-muted-foreground">
                        {secrets.find((y) => y.name === x.name)?.set ? ' · set' : ' · not set'}
                      </span>
                    </>
                  ) : (
                    <code className="text-xs">{pluginSecretVar(m.id, x.name)}</code>
                  )}
                  {x.optional ? <span className="text-muted-foreground"> (optional)</span> : null}
                  {x.inject ? (
                    <span className="text-muted-foreground">
                      {' '}
                      · added to requests to {x.inject.host}
                    </span>
                  ) : x.expose ? (
                    <span className="text-wait"> · readable by the plugin</span>
                  ) : null}
                  {x.description ? (
                    <span className="block text-muted-foreground text-xs">{x.description}</span>
                  ) : null}
                </span>
              ))}
            </dd>
          </>
        ) : null}
        {m.requires.length ? (
          <>
            <dt className="text-muted-foreground">Needs</dt>
            <dd>{m.requires.join(', ')}</dd>
          </>
        ) : null}
      </dl>
      <div>
        <h3 className="caption mb-1.5">Flow steps</h3>
        {m.nodes.length ? (
          <ul className="space-y-1">
            {m.nodes.map((n) => (
              <li key={n.type}>
                {n.label} <span className="text-muted-foreground text-xs">{n.type}</span>
                <span className="block text-muted-foreground text-xs">
                  {CATEGORY_LABELS[n.category]} · outputs {n.outputs.join(', ')}
                  {n.rollback ? ' · undone if the order fails' : ''}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">None</p>
        )}
      </div>
    </div>
  );
}

function Usage({ usage }: { usage: NonNullable<Plugin['usage']> }) {
  return (
    <div className="mt-4 border-t pt-3 text-sm">
      <h3 className="caption mb-1.5">In use</h3>
      {usage.flows.length || usage.orders.length || usage.labels.length ? (
        <p>
          {usage.flows.map((f, i) => (
            <span key={f.id}>
              {i ? ', ' : ''}
              <Link to={`/flows/${f.id}`} className="text-link hover:underline">
                {f.id}
              </Link>{' '}
              <span className="text-muted-foreground">v{f.version}</span>
            </span>
          ))}
          {usage.orders.length ? (
            <span className="block text-muted-foreground">
              {usage.orders.length} running {usage.orders.length === 1 ? 'order' : 'orders'}
            </span>
          ) : null}
          {usage.labels.length ? (
            <span className="block text-muted-foreground">
              {usage.labels.length} {usage.labels.length === 1 ? 'label' : 'labels'} it couldn’t
              void yet (retried daily)
            </span>
          ) : null}
        </p>
      ) : (
        <p className="text-muted-foreground">
          No published flow or running order uses it, so it could be removed.
        </p>
      )}
    </div>
  );
}

function Errors({ errors }: { errors: Plugin['errors'] }) {
  return (
    <div className="mt-4 border-t pt-3 text-sm">
      <h3 className="caption mb-1.5">Recent errors</h3>
      <ul className="grid gap-1">
        {errors.map((e) => (
          <li key={e.id} className="flex gap-3">
            <span className="shrink-0 text-muted-foreground text-xs">
              <Ago ms={e.at} />
            </span>
            <code className="break-all text-xs">{e.message}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Deliveries({ deliveries }: { deliveries: Plugin['deliveries'] }) {
  return (
    <div className="mt-4 border-t pt-3 text-sm">
      <h3 className="caption mb-1.5">Recent events</h3>
      {deliveries.length ? (
        <ul className="space-y-1">
          {deliveries.map((d) => (
            <li key={d.id} className="flex flex-wrap items-baseline gap-x-2">
              <StatusDot status={d.status === 'delivered' ? 'completed' : 'failed'} />
              <span>{d.event}</span>
              <Link to={`/orders/${d.orderId}`} className="text-link text-xs hover:underline">
                {d.orderId}
              </Link>
              <span className="text-muted-foreground text-xs">
                <Ago ms={d.createdAt} />
                {d.attempts > 1 ? ` · ${d.attempts} attempts` : ''}
              </span>
              {d.lastError && d.status !== 'delivered' ? (
                <span className="w-full text-destructive text-xs">{d.lastError}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">None yet.</p>
      )}
    </div>
  );
}
