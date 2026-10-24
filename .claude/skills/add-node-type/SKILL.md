---
name: add-node-type
description: Add a new built-in node type to Order Loop's flow catalog end to end, covering the NODE_SPECS entry, the engine executor (or Workflow interpreter case), the editor icon, the saga compensation for rollback nodes, the outbound webhook event, tests and docs. Use when a flow needs a capability no existing node provides, or when changing an existing node's outputs, fields or rollback. For a plugin's node (namespaced <id>.<name>), see docs/plugins.md instead.
license: MIT
argument-hint: "[category.name]"
metadata:
  repo: orderloop
---

# Adding a node type

A node type that's missing any one of these parts fails late: the editor can't draw it, the
Workflow throws `No executor for <type>` mid-order, or a saga can't undo it. Do all of them in one
change. Read `apps/engine/src/nodes.ts` around a similar node before you start; copy its shape.

## 1. The spec: `packages/core/src/catalog.ts`

Add a `node({...})` to `NODE_SPECS` in its category's section:

- `type`: `<category>.<snake_name>` (`$ARGUMENTS` if given). Once a published flow uses it, the
  type string is permanent.
- `category`, `label`, `description` (one sentence, what it does to the order), `icon` (a
  lucide-react name), `fields` (config, with defaults that validate), `outputs` (the branches it can
  take; a plain node uses `OUT`).
- `rollback: true` only if it has an effect outside the order that a failed order must undo.

Config validation runs through `validateConfig`; if a field has rules, add them where similar
nodes have theirs and test them in `packages/core/tests/graph.test.ts` (node config section).

## 2. The executor: `apps/engine/src/nodes.ts`

Add `'<type>': async ({ env, node, config, ctx, stepKey }) => { … }` to `EXECUTORS`. It returns a
`NodeResult`: `branches`, `output` (persisted step output; never put secrets in it), `summary`
(one line for the timeline), `order` (a patch), `vars`.

- It runs inside the step the Workflow opened for the node. Don't open your own `step.do`, read
  the clock for decisions, or call a model outside what the step already covers.
- **Key every external write by `stepKey`** (a connector call, a Stripe idempotency key, a
  shipment request), so a retried step doesn't write twice.
- Untrusted text into a model goes through `dataBlock`; bound what comes back
  (`packages/core/src/untrusted.ts`).

A `control.*` node (waits, loops, approvals) is interpreted in `apps/engine/src/workflow.ts`
instead; that's rarer and touches determinism directly. Read the `Workflow determinism` section of
the `orderloop-conventions` invariants first.

## 3. The compensation: `ROLLBACKS` in `apps/engine/src/nodes.ts`

Required when the spec has `rollback: true`. Signature `(env, orderId, output) => Promise<string>`,
returning a summary. It must be idempotent (it can run twice) and must tolerate a missing or
partial `output` (the step may have failed before writing all of it): see `commerce.pickup_ready`.

## 4. The icon: `apps/web/app/components/node-icon.tsx`

Import the lucide icon named in the spec and add it to the map. Check every catalog icon resolves:

```bash
grep -oE "icon: '[A-Za-z0-9]+'" packages/core/src/catalog.ts | cut -d"'" -f2 | sort -u |
  while read i; do grep -qw "$i" apps/web/app/components/node-icon.tsx || echo "missing $i"; done
```

## 5. Events and templates

- If integrators should hear about it, add it to `NODE_EVENTS` in `packages/core/src/webhooks.ts`
  (an `OUTBOUND_EVENTS` member, optionally per branch).
- If a built-in flow should use it, add it in `packages/core/src/templates.ts`; every template is
  validated in `graph.test.ts`.

## 6. Tests

- Core: config validation and, if it branches, a planner path through it with `simulate`.
- Engine (`apps/engine/tests/`): an order that runs it, its summary and output; for a rollback
  node, a failed order that compensates it, and a retried step that doesn't write twice.
- If it's a model node, a case in `apps/engine/tests/injection.test.ts`.

## 7. Docs

The node catalog page renders from `NODE_SPECS` at build time, but the guides around it are
hand-written: run the `docs-sync` skill (the `docs-impact` hook names the pages).

## Done when

`preflight` passes, and you can say yes to each: spec, executor, icon, `ROLLBACKS` (if
`rollback: true`), event (if any), tests, docs.
