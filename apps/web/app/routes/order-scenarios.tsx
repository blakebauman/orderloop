import { ORDER_MODEL_LABELS, ORDER_MODELS, type OrderModel, SCENARIOS } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@orderloop/ui/item';
import { Play, TriangleAlert } from 'lucide-react';
import { Link, useLoaderData } from 'react-router';
import { Body, PageHeader, Section } from '~/components/page';
import { useStartOrder } from '~/lib/assistant';
import { requireUser } from '~/lib/auth.server';
import { ensureSeeded } from '~/lib/flows.server';
import { plural } from '~/lib/format';
import { demoAvailable, publishedFlows } from '~/lib/orders.server';
import type { Route } from './+types/order-scenarios';

export const meta = () => [{ title: 'Demo scenarios · OrderLoop' }];

/** What each simulated failure does, in the words the order page will use. */
const FAILS: Record<string, string> = {
  out_of_stock: 'Stock comes up short',
  payment_decline: 'The card is declined',
  charge_fail: 'The renewal charge fails',
  three_way_mismatch: 'The supplier invoice does not match',
};

/** The demo data is only in local dev, tests and demo deployments; elsewhere this page is not. */
async function requireDemo() {
  if (!(await demoAvailable())) throw new Response('Not found', { status: 404 });
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireUser(request, 'operator');
  await ensureSeeded();
  await requireDemo();
  const published = new Map((await publishedFlows()).map((f) => [f.id, f]));
  return {
    scenarios: SCENARIOS.map((s) => {
      const flow = published.get(s.flowId);
      return {
        id: s.id,
        label: s.label,
        blurb: s.blurb,
        model: s.input.model,
        fails: s.input.meta?.simulate ? FAILS[String(s.input.meta.simulate)] : undefined,
        flow: flow ? `${flow.name} · v${flow.version}` : null,
      };
    }),
  };
}

export default function Scenarios() {
  const { scenarios } = useLoaderData<typeof loader>();
  // A scenario starts through the assistant, as one of its tool calls, and opens its order.
  const { start, busy: running, error } = useStartOrder();
  const groups = ORDER_MODELS.map((m) => ({
    model: m,
    items: scenarios.filter((s) => s.model === m),
  })).filter((g) => g.items.length);

  return (
    <>
      <PageHeader
        title="Demo scenarios"
        crumbs={
          <Link to="/orders/new" className="hover:text-foreground">
            New order
          </Link>
        }
        subtitle="Each one starts a real order on the demo data and takes a different path through its flow. Some fail on purpose, to show what happens then."
      />
      <Body>
        <div className="gap-6 xl:columns-2 *:mb-4 *:break-inside-avoid lg:*:mb-6">
          {groups.map((g) => (
            <Section
              key={g.model}
              title={ORDER_MODEL_LABELS[g.model as OrderModel]}
              description={describe(g.items)}
            >
              <ul className="flex flex-col gap-2">
                {g.items.map((s) => (
                  <Item key={s.id} asChild variant="muted" size="sm" className="items-start">
                    <li>
                      <ItemMedia variant="icon" className="mt-0.5 self-start">
                        {/* Nothing has failed yet, so not in `bad`: red stays for what did. */}
                        {s.fails ? (
                          <TriangleAlert className="text-muted-foreground" aria-hidden="true" />
                        ) : (
                          <Play className="text-muted-foreground" aria-hidden="true" />
                        )}
                      </ItemMedia>
                      <ItemContent className="min-w-0 basis-64">
                        <ItemTitle>
                          <h3>{s.label}</h3>
                        </ItemTitle>
                        <ItemDescription className="max-w-measure">{s.blurb}</ItemDescription>
                        <p className="text-xs">
                          <span className="text-muted-foreground">
                            {s.flow ?? 'Flow not published'}
                          </span>
                          {s.fails ? (
                            <span className="text-muted-foreground">
                              {' · '}
                              <span className="font-medium text-foreground">Fails on purpose:</span>{' '}
                              {s.fails}
                            </span>
                          ) : null}
                        </p>
                        {error?.key === s.id ? (
                          <p className="text-bad text-xs" role="alert">
                            {error.message}
                          </p>
                        ) : null}
                      </ItemContent>
                      <ItemActions className="self-center">
                        <Button asChild variant="ghost" size="sm" className="hit-area">
                          <Link to={`/orders/new?scenario=${s.id}`}>Edit first</Link>
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="hit-area"
                          disabled={!s.flow || !!running}
                          aria-label={`Run ${s.label}`}
                          onClick={() => void start(s.id, 'start_scenario', { scenarioId: s.id })}
                        >
                          {running === s.id ? 'Starting…' : 'Run'}
                        </Button>
                      </ItemActions>
                    </li>
                  </Item>
                ))}
              </ul>
            </Section>
          ))}
        </div>
      </Body>
    </>
  );
}

/** A group's line under its title: how many there are, and how many fail on purpose. */
function describe(items: { fails?: string }[]) {
  const failing = items.filter((s) => s.fails).length;
  return `${plural(items.length, 'scenario')}${failing ? `, ${failing} failing on purpose` : ''}.`;
}
