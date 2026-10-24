# OrderLoop Workflow

How one generic Workflow interprets a pinned flow version durably, with deterministic step names, saga rollback and continue-as-new.

`OrderLoop` (`apps/engine/src/workflow.ts`, Workflow `orderloop-order`, binding `ORDER_LOOP`)
interprets every flow. One instance runs one order generation; its params are `OrderLoopParams`:
`orderId`, `flowId`, `version`, `generation`, `order` and `vars`.

## Run

1. **`load-flow`** step: loads the pinned `FlowVersion` from D1 (`loadFlowVersion`). A missing
   version throws `NonRetryableError`.
2. Builds the plan (`initPlan`) and the [run context](https://docs.orderloop.app/reference/expressions/): `order`, `nodes: {}`,
   `vars` from params, `input` = `order.meta`, and `now` = the event's timestamp, not the wall
   clock, so it replays identically.
3. Reports a `running` snapshot to the agent.
4. Loops: `readyNodes` → `beginNode` for each ready node (waiting node types are marked `waiting`)
   → snapshot, sent alongside the batch (awaited in the same `Promise.all`, not before it) → run
   the whole batch concurrently with `Promise.all` → apply the outcomes **in graph order** →
   snapshot. It stops when nothing is ready or an End node ran.
5. Reports the final status. For `failed` it throws `NonRetryableError(reason)`, which fails the
   instance and makes Workflows run the registered rollbacks. Otherwise it returns
   `{ outcome, total }`.

Applying in graph order matters: the batch runs concurrently, so completions arrive in any order,
but the plan they produce must be the same on every replay.

## Step names

Every node run is one memoized step named by its key, `${nodeId}#${run}` (`beginNode`). Run counts
make loop iterations distinct: the third pass of `charge` is `charge#3`. Some node types add
suffixed steps around their main one:

| Step | Node types | Purpose |
|---|---|---|
| `${key}` | executors, `control.loop`, and the batch's `control.continue_as_new` | The node's effect, memoized |
| `${key}:open` | approval, wait for event | Registers the wait with the agent (`openWait`) |
| `${key}` (waitForEvent) | approval, wait for event | `step.waitForEvent` with the node's timeout |
| `${key}:close` | approval, wait for event | Clears the wait (`closeWait`) with the outcome |
| `${key}:until` | `control.wait` with `until` | Evaluates the timestamp once |
| `${key}` (sleep) | `control.wait` | `step.sleep` or `step.sleepUntil` |
| `${key}:emit` | nodes that emit, End, a thrown node | Outbound webhook delivery |

:::caution
Step names are durable identity. Never rename a node id, or change how keys are built, in a way
that would change the step names of a published flow: an in-flight instance replays by name, and a
renamed step runs again.
:::

Effects use a separate key. `effectKey(generation, key)` is `${nodeId}#${run}` in generation 1 and
`${nodeId}#${run}@g${generation}` after a continue-as-new, because run counts restart in every
generation and the step names repeat while their effects must not (a second generation's `charge#1`
charges again). The effect key is what executors receive as `stepKey` (so connector write ids
embed it), what `emit` keys webhook deliveries on, what the wait event types below derive from, and
the `key` of the node's timeline entries. Step names themselves are always the plain key.

Wait event types are derived from the effect key: `approval-${key}` or `event-${key}`, with characters
outside `[a-zA-Z0-9_-]` replaced by `-` (so `mgr#1` becomes `approval-mgr-1`), truncated to 100.

## Executor nodes

Nodes that run inside one step are `EXECUTORS` in `apps/engine/src/nodes.ts`. The step is
configured with:

- `retries`: `{ limit, delay: '5 seconds', backoff: 'exponential' }`, where `limit` is the node's
  `retries`, else the catalog's `retries`, else 3 (`commerce.charge` sets 0).
- `timeout`: the node's `timeout`, else `'5 minutes'`.

An executor returns a `NodeResult`: `branches`, `output`, `summary`, and optional `order` and
`vars` patches. The interpreter applies the patches (`applyResult`) from the memoized result, so a
replay patches the context the same way without running the executor again.

Inside the step the executor sends a durable report when it starts (with an `attempt N` timeline
entry from the second attempt on) and when it finishes.

A thrown executor, once its retries are exhausted, reports the node `failed`, reports the order
`failed`, emits `order.failed` with the node and its error, and rethrows, which fails the instance.

## Interpreted nodes

Waiting and control nodes are handled in `runNode` itself:

- **`control.approval` / `control.wait_event`.** `:open`, then `step.waitForEvent` with
  `TIME_SCALE`-scaled timeout (default `'7 days'` if the node has none), then `:close`. An approval
  takes `approved` when the payload's `decision` is `approved`, otherwise `rejected`; a timeout
  takes `escalated`. An event wait takes `received` or `timeout`, and stores the payload in
  `vars[eventVar(event)]`, so `payment.received` lands in `vars.payment_received`.
- **`control.wait`.** `until` is evaluated in its own step; a positive result sleeps until that
  epoch-ms, otherwise it sleeps for the scaled `duration` (default `'1 day'`).
- **`control.loop`.** One step decides `next = runs <= maxIterations && truthy(while)`; the
  outcome goes to `completeLoop`.
- **`control.end`.** Reports, emits `order.${outcome}`, and ends the run with that outcome and the
  interpolated reason.
- **`control.continue_as_new`.** See below.

## Reports to the agent

Two kinds of report go to `OrderAgent.report` (types in `apps/engine/src/agent.ts`):

- **Plan snapshots** (status, plan, order, vars) are sent from outside steps, so a replay sends
  them again. They carry a `seq` that increments per run; the agent drops any snapshot whose `seq`
  is not newer than what it has for that generation.
- **Detail reports** (node start, finish, summary, output, timeline entries) are sent from inside
  executor steps (or, for waits and loops, once the memoized step has returned) and carry no `seq`. Timeline entries have a `key`, and the agent replaces an entry with the
  same key instead of appending, so a retried step does not duplicate history.

Report failures are logged and swallowed: the UI must never fail an order. See
[OrderAgent](order-agent.md#reports).

## Rollback

A node type with `rollback: true` in the catalog registers a compensation on its step from
`ROLLBACKS`:

| Node type | Compensation |
|---|---|
| `commerce.reserve_inventory` | `releaseInventory`: releases every held reservation |
| `commerce.authorize_payment` | `voidAuthorizations`: voids every open authorization; a Stripe one is canceled in Stripe first (an already-canceled PaymentIntent counts) and marked `voided` only after |
| `commerce.split_by_seller` | `cancelSellerOrders`: cancels every pending or accepted seller order |
| `commerce.payout` | `reversePayouts`: reverses every scheduled payout |
| `commerce.ship` | `cancelShipment` for every shipment id in the step's output (`shipments`; one per source location on a split), then `restoreShippedStock`: once none of the order's shipments is live (`label_created`, `ready_for_pickup`, `collected`), stock its shipments consumed goes back, each reservation once |
| `commerce.pickup_ready` | `cancelShipment` for the staged pickup's shipment id in the step's output |
| `commerce.deliver_digital` | `revokeEntitlements`: revokes every issued code |
| `commerce.invoice` | `voidInvoices` (`apps/engine/src/billing.ts`): voids each unpaid Stripe invoice in Stripe (a draft is deleted) before marking it `void`; one Stripe reports paid is left alone and named in the summary. Then `reverseBalance`: reverses each on-account balance entry once, with a negative `rev_` entry, skipping one its paid invoice already settled (`set_`) |

Each runs with `{ retries: { limit: 3, delay: '10 seconds', backoff: 'linear' }, timeout: '2 minutes' }`
and reports the node `rolled_back`. A failed report is logged, not thrown, so Workflows never reruns a compensation that already ran. When the instance fails (an End node with outcome `failed`, or a
thrown node) Workflows runs the compensations in reverse order. The agent then polls the instance
to record the rollback outcome (see [OrderAgent](order-agent.md#rollback-outcome)).

Cancelling does not go through rollback: the agent terminates the instance and calls
`compensateOrder` directly.

## Outbound webhooks

`emitStep` delivers one event in its own `${key}:emit` step with
`{ retries: { limit: 5, delay: '10 seconds', backoff: 'exponential' }, timeout: '1 minute' }`. The
step calls `emit` (`apps/engine/src/outbox.ts`), which records one `webhook_deliveries` row per
matching subscription, keyed `whd_${orderId}_${stepKey}_${subscriptionId}`, then attempts every row
for that key not yet `delivered`. The step throws while any are pending, so Workflows retries it;
when retries run out the error is swallowed, the rows stay `failed`, and the order carries on.

Which nodes emit is `NODE_EVENTS` in `packages/core/src/webhooks.ts`; see
[Outbound webhooks](https://docs.orderloop.app/guides/outbound-webhooks/).

## Continue as new

A long-lived flow (the subscription template) would otherwise grow its step history without bound.
`control.continue_as_new` only returns `{ kind: 'continue' }` from its node; the next generation
starts after the whole batch is applied, so the outputs of its siblings in the batch carry over in
`order` and `vars`. `continueAsNew` then runs one step, named by the node's key, that creates a new
instance with id `${orderId}-g${generation + 1}` and params carrying the current `order` and `vars`,
then calls `agent.continuedAs(id, generation)`. It is retry-safe: if `create` threw but the
instance exists (a retry after it succeeded), the step goes on to `continuedAs`. If the batch also
reached an End node, the end wins and no new generation starts. The current run returns
`{ continuedAs }`.

Generation 1's instance id is `${orderId}-g1` (set by `startOrder` in `apps/engine/src/orders.ts`).
Each generation starts its own `seq` from zero, and the agent accepts any report from a newer
generation.

## Time scale

`scaled(env, duration)` divides every wait, sleep and wait timeout by `TIME_SCALE`
(default `"1440"`: a day becomes a minute) and never goes below one second. Step retry delays and
timeouts are not scaled. Set `TIME_SCALE` to `"1"` for real time.

## Determinism rules

- Every effect happens inside a `step.do`; anything that reads time or calls a model is a step too.
- The planner is pure, and nodes are applied in graph order after each batch.
- `ctx.now` is the instance's start timestamp.
- Step names never change for a published flow.
