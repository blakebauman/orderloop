import { ORDER_MODEL_LABELS, ORDER_MODELS, type OrderModel } from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Form, Link, useActionData, useLoaderData, useNavigation } from 'react-router';
import { PageHeader, Section } from '~/components/page';
import { requireUser } from '~/lib/auth.server';
import { ensureSeeded } from '~/lib/flows.server';
import { demoAvailable, publishedFlows } from '~/lib/orders.server';
import { SCENARIOS } from '~/lib/scenarios';
import { startScenario } from '~/lib/scenarios.server';
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

export async function action({ request }: Route.ActionArgs) {
  const me = await requireUser(request, 'operator');
  await requireDemo();
  return startScenario(request, me, String((await request.formData()).get('scenario') ?? ''));
}

export default function Scenarios() {
  const { scenarios } = useLoaderData<typeof loader>();
  const data = useActionData<typeof action>();
  const nav = useNavigation();
  const running = nav.state !== 'idle' ? String(nav.formData?.get('scenario') ?? '') : '';
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
      <div className="mx-auto max-w-page px-4 pb-10 sm:px-6">
        <div className="max-w-[1000px] space-y-6">
          {groups.map((g) => (
            <Section key={g.model} title={ORDER_MODEL_LABELS[g.model as OrderModel]} flush>
              <ul className="divide-y">
                {g.items.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-start gap-x-6 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-80">
                      <h3 className="font-medium text-sm">{s.label}</h3>
                      <p className="mt-0.5 max-w-[68ch] text-muted-foreground text-sm">{s.blurb}</p>
                      <p className="mt-1 text-xs">
                        <span className="text-muted-foreground">
                          {s.flow ?? 'Flow not published'}
                        </span>
                        {s.fails ? <span className="text-bad"> · Fails: {s.fails}</span> : null}
                      </p>
                      {data?.id === s.id && data.error ? (
                        <p className="mt-1 text-bad text-xs" role="alert">
                          {data.error}
                        </p>
                      ) : null}
                    </div>
                    <div className="flex items-center gap-3">
                      <Link
                        to={`/orders/new?scenario=${s.id}`}
                        className="text-link text-sm hover:underline"
                      >
                        Edit first
                      </Link>
                      <Form method="post">
                        <input type="hidden" name="scenario" value={s.id} />
                        <Button
                          type="submit"
                          size="sm"
                          variant="outline"
                          disabled={!s.flow || !!running}
                          aria-label={`Run ${s.label}`}
                        >
                          {running === s.id ? 'Starting…' : 'Run'}
                        </Button>
                      </Form>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ))}
        </div>
      </div>
    </>
  );
}
