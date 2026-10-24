import { CATEGORY_LABELS, pluginSecretVar, ROLE_LABELS } from '@orderloop/core';
import { Link, useLoaderData } from 'react-router';
import { Ago } from '~/components/ago';
import { Body, Empty, PageHeader, Section } from '~/components/page';
import { StatusDot } from '~/components/status';
import { requireUser } from '~/lib/auth.server';
import { engine } from '~/lib/env.server';
import { listDeliveries } from '~/lib/webhooks.server';
import type { Route } from './+types/plugins';

export const meta = () => [{ title: 'Plugins · OrderLoop' }];

const RECENT = 10;

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request, 'admin');
  const statuses = await engine().pluginCatalog();
  const plugins = await Promise.all(
    statuses.map(async (s) => {
      // A refused plugin has no manifest, but its id follows from its binding: that is when its
      // flows and running orders matter most.
      const id =
        s.manifest?.id ?? s.binding.slice('PLUGIN_'.length).toLowerCase().replaceAll('_', '-');
      const [usage, deliveries] = await Promise.all([
        engine().pluginUsage(id),
        listDeliveries(`plugin:${id}`, RECENT),
      ]);
      return {
        ...s,
        usage,
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
  return { plugins };
}

export default function Plugins() {
  const { plugins } = useLoaderData<typeof loader>();
  return (
    <>
      <PageHeader
        title="Plugins"
        subtitle="Optional features installed on this workspace, each running on its own. What they add to flows, what they are sent, and whether they are answering. Installing or removing one is a change to this deployment; ask OrderLoop."
      />
      <Body className="space-y-4">
        {plugins.length ? (
          plugins.map((p) => <PluginSection key={p.binding} plugin={p} />)
        ) : (
          <Section title="Installed">
            <Empty>No plugins are installed on this workspace.</Empty>
          </Section>
        )}
      </Body>
    </>
  );
}

type Plugin = Awaited<ReturnType<typeof loader>>['plugins'][number];

function PluginSection({ plugin: p }: { plugin: Plugin }) {
  const m = p.manifest;
  const title = m ? (
    <>
      {m.name}{' '}
      <span className="font-normal text-muted-foreground text-xs">
        {m.id} · version {m.version}
      </span>
    </>
  ) : (
    p.binding
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
        <div className="grid gap-4 text-sm md:grid-cols-2">
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5">
            <dt className="text-muted-foreground">Contract</dt>
            <dd className="tabular">v{m.apiVersion}</dd>
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
            {m.secrets.length ? (
              <>
                <dt className="text-muted-foreground">Secrets</dt>
                <dd>
                  {m.secrets.map((x) => (
                    <span key={x.name} className="block">
                      <code className="text-xs">{pluginSecretVar(m.id, x.name)}</code>
                      {x.optional ? (
                        <span className="text-muted-foreground"> (optional)</span>
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
      ) : null}
      {p.usage ? <Usage usage={p.usage} /> : null}
      {m?.events.length || p.deliveries.length ? <Deliveries deliveries={p.deliveries} /> : null}
    </Section>
  );
}

function Usage({ usage }: { usage: NonNullable<Plugin['usage']> }) {
  return (
    <div className="mt-4 border-t pt-3 text-sm">
      <h3 className="caption mb-1.5">In use</h3>
      {usage.flows.length || usage.orders.length ? (
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
        </p>
      ) : (
        <p className="text-muted-foreground">
          No published flow or running order uses it, so it could be removed.
        </p>
      )}
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
