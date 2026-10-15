# OrderAgent

The per-order Durable Object that holds live state, owns waits and approvals, and cancels.

`OrderAgent` (`apps/engine/src/agent.ts`) is an Agents SDK `Agent`, one Durable Object per order,
named by the order id (`orderAgentName` in `@orderloop/core`). It:

- holds the order's live state, synced to every browser on the order page through `useAgent`;
- records what the Workflow reports;
- owns the order's waits and delivers approvals and events to the right instance;
- cancels with compensation.

Questions about an order go to the person's [workspace assistant](https://docs.orderloop.app/guides/assistant/), which reads
and acts on the order through this agent.

## State

The synced state is `OrderState` from `packages/core/src/api.ts`, plus a private `seq`:

| Field | Meaning |
|---|---|
| `orderId`, `order`, `flow` | The order and the pinned `FlowVersion` |
| `status` | One of `ORDER_STATUSES` (`packages/core/src/types.ts`) |
| `nodes` | `NodeRun` per node: status, runs, summary, output, error, branches, `startedAt`, `endedAt` |
| `edges` | `EdgeState` per edge, from the latest plan |
| `waits` | Open `PendingWait`s: node, event type, kind, title, event, amount, assignee, deadline |
| `vars` | Run variables |
| `timeline` | `TimelineEntry`s, capped at the last 400 (`TIMELINE_CAP`) |
| `instanceId`, `generation` | The Workflow instance driving the order and its generation |
| `rollback` | `{ outcome: 'complete' \| 'failed', error }` once a failed run has settled |
| `reason` | Why it was cancelled, declined or failed |

`validateStateChange` throws for any change whose source is not the server: browsers may read
state and call methods, never write state.

`init(order, flow, instanceId)` is called by `startOrder` (a repeat call with the same instance id is ignored, so a replayed start never resets a run): status `queued`, every node
`pending`, generation 1, and a first timeline entry naming the flow and version.

## Reports

`report(r)` merges a report from the Workflow (see
[OrderLoop Workflow](workflow.md#reports-to-the-agent)):

- **Sequenced** reports (with `seq`) are fresh if they come from a newer generation, or the same
  generation with a higher `seq`. Only fresh ones update `plan`, `order` and `vars`. A plan never
  clears a node already `rolled_back` or `failed`; those come from their own reports.
- **Unsequenced** detail reports always apply their `node` patch and `log` entry.
- A `status` applies only if the order is not already terminal
  (`TERMINAL_ORDER_STATUSES` in `packages/core/src/types.ts`), so a late report cannot reopen a finished order. A
  status change adds a timeline entry keyed `status:${generation}:${status}`.
- Timeline entries with a `key` replace the entry with the same key rather than appending.

After a status change or an order patch the agent writes the index row (`syncIndex`). When the
status becomes `failed` it schedules `checkInstance` to run 5 seconds later.

### Node timing

A node patch with `startedAt` starts a run, unless the node is already running (started, not
ended); a retried attempt then keeps the run's first start, so a duration includes its retries.
Waits start in `openWait`. The first `endedAt` for a running node, at or after its start, writes a
`node_runs` row (`recordRun`, `onConflictDoNothing`), with the run number from the plan and the
generation. A replayed report reaches a node that has already ended, or a later run of it, so it
never adds a row. Nodes without a start (an End node, a `control.wait` sleep) are not timed.

These rules are what make replays and retries safe: `apps/engine/tests/agent.test.ts` covers
replayed snapshots, deduped keys, new generations and sticky terminal statuses.

## The orders index

`syncIndex` updates the order's D1 `orders` row from state: `status`, `total`, `customer_id`,
`title`, `fx_rate`, `instance_id`, `generation`, `waiting_on` (the titles of open waits joined with ` · `),
`waiting_at` (the labels of the steps holding them), `waiting_since` (when the oldest began) and
`updated_at`. It writes only when one of those indexed fields changed since its last write, so `updated_at` moves on a meaningful change, not on every report. The orders list shows `waiting_at` and how long the order has waited. The dashboard and `GET /api/v1/orders` read that row; `GET /api/v1/orders/:id` reads
the agent.

## Waits

The Workflow calls `openWait` from a node's `:open` step and `closeWait` from its `:close` step.

- `openWait(w)` is a no-op if a wait with the same `eventType` is already open (a retried step).
  For an approval it inserts an `approvals` row (`status: 'pending'`, `onConflictDoNothing`), then
  adds the wait, starts the node's run at the wait's `since`, and adds an `open:${eventType}`
  timeline entry.
- `closeWait(eventType, outcome, payload)` updates the approval row with the outcome, `decided_at`,
  `decided_by` (the payload's `by`, `timeout` for an escalation) and `note`, removes the wait, and
  adds a `close:${eventType}` entry.

## Callable methods

Methods marked `@callable()` can be called from the order page over the socket; `EngineApi` calls
the same methods over RPC.

| Method | Behaviour |
|---|---|
| `decide(nodeId, decision, by = 'operator', note?, deciderId?)` | First checks separation of duties: `separationRefusal` (`apps/engine/src/separation.ts`) reads `approval_separation` and `orders.started_by` and throws `OWN_ORDER_REFUSAL` when `ownOrderRefusal` (core) says the decider started the order. `deciderId` comes from RPC callers (the REST route, the order action, the assistant); on a socket it is the signed-in caller's id. Without one (no principal), nothing is checked. Then finds the approval wait for `nodeId` (throws if none) and sends its event type to the instance with `{ decision, by, note }` |
| `deliver(event, payload = {})` | Finds the event wait for `event`. If none is open, returns `{ delivered: false }`; otherwise sends `{ ...payload, event, at }` and returns `{ delivered: true, nodeId }` |
| `cancel(reason = 'Cancelled by operator')` | See below. Returns `{ ok: false }` for an order that has already ended |
| `erasePersonalData(terms)` | Not `@callable()`; RPC only, from `eraseDataSubject`. Returns `null` while the order has not ended (a status outside `TERMINAL_ORDER_STATUSES`), `{ held: false, title: '' }` for an agent that never held an order, otherwise replaces the state with `eraseOrderState(state, terms)` (core), runs `syncIndex` and returns `{ held: true, title }` |
| `whoami()` | The caller as the agent sees them now, `{ name, role }`; fails once their sign-in has ended |

### Roles on the socket

The web app proxies the socket with the signed-in principal in `x-orderloop-principal`
(`PRINCIPAL_HEADER`, base64 JSON from `encodePrincipal` in `packages/core/src/roles.ts`), set by the
web Worker after removing any copy the browser sent; the engine has no public route. `onConnect`
stores it as the connection's state. For a signed-in person the header also carries their
session's id (the SHA-256 that keys `sessions`), which never reaches the browser.

Each callable calls `authorize(min)`. On a socket call it re-reads the session and its user from
D1 (`livePrincipal` in `apps/engine/src/principal.ts`, shared with the
[AssistantAgent](architecture.md#the-assistant)), so a page that is already open follows changes made since it connected: a lower role applies
at once, and once the session has been signed out, reset, expired or idle for `SESSION_IDLE_MS`,
or the user disabled, the
call fails with `Your sign-in has ended. Reload the page to sign in again.` and the connection
closes with code `4401` just after. A successful check also records the session's activity
(`last_seen_at`, at most every `SESSION_TOUCH_MS`), so working on an order page keeps it from
going idle. A caller without at least `min` gets `This needs the <Role>
role.`; a socket with no principal is refused. API tokens and open local dev have no
session to re-check. Calls over RPC have no connection and are trusted, because the web app's
routes already checked the role.

### Audit on the socket

`decide`, `deliver` and `cancel` write a business audit row (`recordAudit`, `apps/engine/src/audit.ts`:
`approval.decided`, `order.event_delivered`, `order.cancelled`, `via: 'app'`, actor the signed-in person) only when
there is a socket caller. An RPC caller (the web app's routes, the assistant) records its own, so the row is written
once. `deliver` records only when an event wait was open. Writing never throws.

| Method | Socket role |
|---|---|
| `whoami` | `viewer` |
| `decide` | `approver`; `by` is replaced by the caller's email (or name) and `deciderId` by the caller's id |
| `deliver`, `cancel` | `operator` |

Readonly connections (`shouldConnectionBeReadonly`) aren't used: they would also block the agent's
own state writes.

`deliver` returning `delivered: false` is what lets `POST /api/v1/webhooks/events` answer `409`
until a node is waiting for the event. Stripe events take the same path from inside the engine:
`handleStripeEvent` (`apps/engine/src/payment-events.ts`, behind `EngineRpc.paymentEvent`) calls
`deliver` for `payment.received` and `payment.disputed`, and answers `retry` (the web app's `409`)
when nothing waits yet and the order hasn't ended.

## Cancel

`cancel` terminates the Workflow instance (logging, not failing, if that throws), runs
`compensateOrder` (release held stock, void open authorizations, cancel booked shipments and staged pickups, cancel seller orders, reverse scheduled payouts, revoke issued digital codes, void unpaid Stripe invoices, restock consumed stock once no shipment is live, then reverse on-account invoice charges not already settled by a paid invoice), marks
every pending approval row `cancelled`, sets status `cancelled` with the reason and clears the
waits. Terminating means no End node runs, so the agent announces the ending itself: it schedules
`emitWebhook` for `order.cancelled`. A second `cancel` that arrives while the first is still running returns `{ ok: false }` without doing anything.

## A2A watchers

An [A2A](https://docs.orderloop.app/reference/a2a/) task that follows this order calls `watch(name)`, which records the
caller's `A2AAgent` name in `a2a_watchers` (repeats are ignored). `onStateChanged` computes a key
from the status and the event types the order waits on; when it differs from the last one stored
(`a2a_watch_state`) and someone watches, it schedules `notifyWatchers({ names, attempt })` at once.
That calls `orderChanged(orderId)` on each watcher's `A2AAgent`. A watcher that can't be reached is
retried with the webhooks' backoff (`10 * 2^attempt` seconds, up to 5 retries, `WEBHOOK_RETRIES`).
When the order has finished and everyone has heard, `a2a_watchers` is cleared.

## Agent-side webhooks

`emitWebhook({ key, event, data, attempt })` calls the same `emit` as the Workflow's emit steps,
keyed by `key`. While deliveries are pending it reschedules itself after `10 * 2^attempt` seconds,
up to 5 retries (`WEBHOOK_RETRIES`), matching the Workflow's backoff, then leaves the rows `failed`.

## Rollback outcome

A failed instance runs its compensations inside Workflows, after the order is already `failed`.
`checkInstance` polls the instance status every 10 seconds (up to 60 attempts) until it is
`errored`, `terminated` or `complete`, then records `rollback` from the instance's `rollback`
field. Runtimes that omit that field (including local dev) fall back to the node reports: an
errored instance with any `rolled_back` node counts as a complete rollback. A complete rollback
sets status `rolled_back`; a failed one stays `failed` with the error.

## Continue as new

`continuedAs(instanceId, generation)` ignores anything not newer than the current generation, then
switches `instanceId` and `generation`, resets `seq` to 0 and logs `Continued as run N`.
