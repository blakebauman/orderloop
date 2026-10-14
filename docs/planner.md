# Planner

The pure state machine that decides which nodes run, which are skipped, and how loops repeat.

The planner in `packages/core/src/graph.ts` is the only place flow semantics live. It is a pure
function of a graph and a `PlanState`, with no I/O, so it is unit tested in Node
(`packages/core/tests/graph.test.ts`). The [OrderLoop Workflow](workflow.md) drives it and
adds durability; it never re-implements scheduling.

## State

```ts
type EdgeState = 'pending' | 'active' | 'inactive';

type PlanNode = {
  status: NodeStatus;   // pending | running | waiting | succeeded | failed | skipped | rolled_back
  runs: number;         // how many times the node started; part of its step name
  branches?: string[];  // the outputs it chose last time
};

type PlanState = { nodes: Record<string, PlanNode>; edges: Record<string, EdgeState> };
```

`initPlan(graph)` sets every node `pending` with `runs: 0` and every edge `pending`.

An edge leaves its source from an output (`sourceHandle`, defaulting to `out`; see `edgeHandle`).
An edge whose `targetHandle` is `next` is a **back-edge** into a `control.loop` node (`isBackEdge`);
every other edge is a forward input.

## The loop the Workflow runs

```ts
const { ready } = readyNodes(graph, plan);      // resolve skips, list runnable nodes
for (const id of ready) key = beginNode(plan, id); // runs += 1, status running, key `${id}#${runs}`
// … execute every ready node …
completeNode(graph, plan, id, branches);        // or completeLoop(graph, plan, id, next)
```

Repeat until `readyNodes` returns nothing.

## Readiness: an AND-join that tolerates untaken branches

A pending node with forward inputs is **ready** when every forward input is resolved (not
`pending`) and at least one is `active`. A node whose inputs all come from branches that were not
taken does not wait forever: it is skipped instead.

A node with no forward inputs (the trigger) is ready once, while `runs === 0`.

A node with an `active` back-edge is ready regardless of its forward inputs: that is a loop being
re-entered.

## Skip propagation

Before listing ready nodes, `readyNodes` repeats to a fixpoint: any pending node whose forward
inputs are all resolved and all `inactive` becomes `skipped`, and its out-edges become `inactive`.
That can resolve the inputs of the next node down, so the pass repeats until nothing changes.
Skipping therefore runs down every path that depends only on an untaken branch, and stops at the
first join that still has an active input.

`readyNodes` returns `{ ready, skipped }` and mutates the state for the skips. `ready` is in graph
order (the order of `graph.nodes`); `skipped` is in the order the passes resolved them.

## Completing a node

`completeNode(graph, state, id, branches)` marks the node `succeeded` and records its branches.
Each out-edge becomes `active` if its handle is in `branches`, otherwise `inactive`. Single-output
nodes complete with `['out']`; End and Continue-as-new complete with `[]`, which deactivates
everything after them.

It also resets the node's own incoming back-edges to `pending` (they are consumed once the loop has
run), and an out-edge that is an active back-edge sets its target loop back to `pending`.

## Loops

A `control.loop` node has two outputs, `body` and `done`, and accepts back-edges on `next`.
`loopRegion(graph, loopId)` is every node reachable from the loop's `body` output without passing
back through the loop or along a back-edge.

`completeLoop(graph, state, loopId, next)`:

- With `next: true`, resets every node in the region to `pending` and every edge leaving the region
  to `pending`, then completes the loop on `body`. Run counts are **kept**, so the next iteration's
  step names are new (`charge#2`, `charge#3`, …).
- With `next: false`, completes the loop on `done`.
- While iterating it puts the `done` edges back to `pending` rather than leaving them `inactive`.
  Deciding to iterate does not decide the exit, so nothing after the loop is skipped before the
  final iteration.

The Workflow decides `next` as `runs <= maxIterations && while`, inside a step.

## Settled

`isSettled(graph, state)` is true when no node is `running` or `waiting` and a dry run of
`readyNodes` on a clone finds nothing ready.

## Worked example

A condition `big` with outputs `true` / `false`, an approval on `true`, and a join `ship` fed by
both paths:

```
trigger ─► big ─true──► approve ─approved─► ship
              └─false──────────────────────► ship
```

1. `trigger` is ready (no inputs, `runs 0`). It completes on `out`; `trigger→big` is `active`.
2. `big` is ready. It completes on `false`: `big.false→ship` is `active`, `big.true→approve` is
   `inactive`.
3. Skip pass: `approve`'s only input is `inactive`, so it is `skipped` and `approve.approved→ship`
   becomes `inactive`.
4. `ship` now has both inputs resolved, one `active`: it is ready and runs once.

Had `big` chosen `true`, `ship` would wait for `approve`; a rejection would make
`approve.approved→ship` inactive, and `ship` would be skipped because both of its inputs were
untaken.

## Validation

`validateGraph(graph)` returns `{ errors, warnings }` as `GraphIssue`s (`nodeId?`, `edgeId?`,
`message`). The editor shows them and refuses to publish while there are errors.

Errors:

- Duplicate node ids; unknown node types; node config that fails its catalog fields
  (`validateConfig`).
- Not exactly one trigger.
- An edge pointing at a missing node; an edge from an output the source does not have; a `next`
  edge into anything but a Loop; any edge into a trigger.
- A cycle among forward edges (they must form a DAG; repetition goes through a Loop's `next`).
- A non-trigger node with no forward input.
- A `next` edge that does not come from inside that loop's body region.

Warnings: duplicate edges, and a node with outputs but no outgoing edge (the run ends there).

`topologyKey(graph)` changes only when node ids or edges change; the editor uses it to decide
when to re-layout.

## Determinism

The planner has no clock, randomness or I/O, and every pass iterates `graph.nodes` in order. Given
the same graph and the same sequence of completions it produces the same states and the same step
keys, which is what lets the Workflow replay after hibernation. Anything a decision depends on
(a condition's value, a loop's `next`) is computed inside a step and fed back in as data.

## Adding planner behaviour

Change `graph.ts` and add a case to `packages/core/tests/graph.test.ts`. Its `simulate(graph,
choose)` helper drives the planner the way the interpreter does, with `choose(id, run)` standing
in for execution, and returns the nodes in the order they ran. See [Testing](testing.md).
