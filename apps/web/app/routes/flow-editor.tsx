import {
  type CopilotResult,
  type Flow,
  type FlowGraph,
  type FlowNode,
  ORDER_TYPE_LABELS,
  ORDER_TYPES,
  type OrderType,
  validateGraph,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import {
  AlertTriangle,
  CheckCircle2,
  FlaskConical,
  Redo2,
  Rocket,
  Save,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { data, Link, useBlocker, useFetcher, useLoaderData, useNavigate } from 'react-router';
import { Connections } from '~/components/connections';
import { FlowCanvas, makeNode } from '~/components/flow-canvas';
import { Inspector } from '~/components/inspector';
import { Palette } from '~/components/palette';
import { requireUser } from '~/lib/auth.server';
import { getFlow } from '~/lib/flows.server';
import type { Route } from './+types/flow-editor';

export const meta = ({ loaderData: d }: Route.MetaArgs) => [
  { title: `${d?.flow.name ?? 'Flow'} · Order Loop` },
];

export async function loader({ request, params }: Route.LoaderArgs) {
  await requireUser(request);
  const found = await getFlow(params.flowId);
  if (!found) throw data('Flow not found', { status: 404 });
  return found;
}

type ActionResult = {
  error?: string;
  saved?: boolean;
  version?: number | null;
  orderId?: string;
  errors?: { nodeId?: string; message: string }[];
};

export default function FlowEditor() {
  const loaded = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [flow, setFlowState] = useState<Flow>(loaded.flow);

  // Edit history. Every change goes through setFlow; bursts (a drag, typing) within 400ms are one
  // step, so ⌘Z undoes a whole move rather than one pixel of it.
  const flowRef = useRef(flow);
  const past = useRef<Flow[]>([]);
  const future = useRef<Flow[]>([]);
  const lastEdit = useRef(0);
  const [, setHistoryTick] = useState(0);
  const setFlow = useCallback((next: Flow | ((f: Flow) => Flow)) => {
    const prev = flowRef.current;
    const value = typeof next === 'function' ? next(prev) : next;
    if (value === prev) return;
    const now = Date.now();
    if (now - lastEdit.current > 400) {
      past.current.push(prev);
      if (past.current.length > 100) past.current.shift();
    }
    lastEdit.current = now;
    future.current = [];
    flowRef.current = value;
    setFlowState(value);
    setHistoryTick((t) => t + 1);
  }, []);
  const travel = useCallback((from: React.RefObject<Flow[]>, to: React.RefObject<Flow[]>) => {
    const target = from.current.pop();
    if (!target) return;
    to.current.push(flowRef.current);
    flowRef.current = target;
    lastEdit.current = 0;
    setFlowState(target);
    setHistoryTick((t) => t + 1);
  }, []);
  const undo = useCallback(() => travel(past, future), [travel]);
  const redo = useCallback(() => travel(future, past), [travel]);
  const [baseline, setBaseline] = useState(() => JSON.stringify(loaded.flow));
  const [selected, setSelected] = useState<string | null>(null);
  const [published, setPublished] = useState(loaded.publishedVersion);
  // The graph as last published, to know whether Publish would change anything.
  const [publishedGraph, setPublishedGraph] = useState<FlowGraph | null>(loaded.publishedGraph);
  // Publishing (directly or as part of a test run) always passes through one confirmation.
  const [confirm, setConfirm] = useState<null | 'publish' | 'test'>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [prompt, setPrompt] = useState('');
  const [proposal, setProposal] = useState<CopilotResult | null>(null);
  const save = useFetcher<ActionResult>();
  const copilot = useFetcher<CopilotResult & { error?: string }>();

  const dirty = JSON.stringify(flow) !== baseline;
  const issues = useMemo(() => validateGraph(flow), [flow]);
  const nodeIssues = useMemo(
    () =>
      Object.fromEntries(issues.errors.filter((e) => e.nodeId).map((e) => [e.nodeId!, e.message])),
    [issues],
  );
  const node = selected ? flow.nodes.find((n) => n.id === selected) : undefined;

  const setGraph = useCallback(
    (g: FlowGraph) => setFlow((f) => ({ ...f, nodes: g.nodes, edges: g.edges })),
    [],
  );

  const submit = useCallback(
    (intent: 'save' | 'publish' | 'test') => {
      save.submit(JSON.stringify({ intent, flow }), {
        method: 'post',
        action: `/flows/${flow.id}/action`,
        encType: 'application/json',
      });
    },
    [flow, save],
  );

  // Handle save / publish / test results.
  // React to new results only.
  useEffect(() => {
    const d = save.data;
    if (!d || save.state !== 'idle') return;
    if (d.error) setNotice({ tone: 'err', text: d.error });
    else if (d.version === null)
      setNotice({
        tone: 'err',
        text: `Not published: ${d.errors?.[0]?.message ?? 'fix the errors first'}`,
      });
    else {
      setBaseline(JSON.stringify(flow));
      if (d.version) {
        setPublished(d.version);
        setPublishedGraph({ nodes: flow.nodes, edges: flow.edges });
      }
      setNotice({ tone: 'ok', text: d.version ? `Published v${d.version}` : 'Draft saved' });
      if (d.orderId) navigate(`/orders/${d.orderId}`);
    }
  }, [save.data, save.state]);

  useEffect(() => {
    if (copilot.state !== 'idle' || !copilot.data) return;
    if (copilot.data.error) setNotice({ tone: 'err', text: copilot.data.error });
    else setProposal(copilot.data);
  }, [copilot.data, copilot.state]);

  // ⌘S saves, ⌘Z / ⇧⌘Z undo and redo graph edits (text fields keep their own undo), Escape deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 's') {
        e.preventDefault();
        submit('save');
      }
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select');
      if (mod && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      }
      if (mod && e.key.toLowerCase() === 'y' && !typing) {
        e.preventDefault();
        redo();
      }
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit, undo, redo]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      currentLocation.pathname !== nextLocation.pathname &&
      !nextLocation.pathname.startsWith('/orders/'),
  );

  const changes = useMemo(() => graphChanges(publishedGraph, flow), [publishedGraph, flow]);
  const unpublished = !publishedGraph || changes.total > 0;

  const addNode = (type: string, position?: { x: number; y: number }) => {
    const anchor = node ?? flow.nodes.at(-1);
    const pos =
      position ??
      (anchor ? { x: anchor.position.x + 280, y: anchor.position.y } : { x: 56, y: 160 });
    const n = makeNode(flow, type, pos);
    setFlow((f) => {
      const edges = [...f.edges];
      // Clicking a palette item with a single-output node selected wires it in after that node.
      if (!position && node && !node.type.startsWith('control.end')) {
        const outs = f.edges.filter((e) => e.source === node.id);
        if (!outs.length) edges.push({ id: `${node.id}-${n.id}`, source: node.id, target: n.id });
      }
      return { ...f, nodes: [...f.nodes, n], edges };
    });
    setSelected(n.id);
  };

  const updateNode = (n: FlowNode) =>
    setFlow((f) => ({ ...f, nodes: f.nodes.map((x) => (x.id === n.id ? n : x)) }));
  const deleteNode = (id: string) => {
    setFlow((f) => ({
      ...f,
      nodes: f.nodes.filter((n) => n.id !== id),
      edges: f.edges.filter((e) => e.source !== id && e.target !== id),
    }));
    setSelected(null);
  };

  const diff = proposal
    ? {
        added: proposal.graph.nodes.filter((n) => !flow.nodes.some((m) => m.id === n.id)).length,
        removed: flow.nodes.filter((n) => !proposal.graph.nodes.some((m) => m.id === n.id)).length,
        edges: proposal.graph.edges.length - flow.edges.length,
      }
    : null;

  return (
    <div className="flex flex-col lg:h-[calc(100dvh-3rem)]">
      <header className="flex flex-wrap items-center gap-3 border-b px-4 py-2.5 sm:px-5">
        <div className="min-w-0">
          <div className="caption">
            <Link to="/flows" className="hover:text-foreground hover:underline">
              Flows
            </Link>{' '}
            / <span className="font-mono">{flow.id}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={flow.name}
              onChange={(e) => setFlow({ ...flow, name: e.target.value })}
              className="h-8 w-full border-transparent bg-transparent px-1 font-semibold font-serif text-lg hover:border-input sm:w-64"
              aria-label="Flow name"
            />
            <NativeSelect
              value={flow.orderType}
              onChange={(e) => setFlow({ ...flow, orderType: e.target.value as OrderType })}
              className="h-8 text-sm"
              aria-label="Order type"
            >
              {ORDER_TYPES.map((t) => (
                <NativeSelectOption key={t} value={t}>
                  {ORDER_TYPE_LABELS[t]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span className="text-muted-foreground text-xs">
              {published
                ? `Published v${published}${unpublished ? ' · changes not published' : ''}`
                : 'Not published'}
            </span>
            {dirty ? (
              <span className="rounded-sm bg-wait/15 px-1.5 py-0.5 font-medium text-wait text-xs">
                Unsaved
              </span>
            ) : null}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {notice ? (
            <span
              role="status"
              className={cn(
                'text-sm',
                notice.tone === 'ok'
                  ? 'text-ok'
                  : notice.tone === 'warn'
                    ? 'text-wait'
                    : 'text-bad',
              )}
            >
              {notice.text}
            </span>
          ) : null}
          <div className="flex">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!past.current.length}
              onClick={undo}
              aria-label="Undo (⌘Z)"
              title="Undo (⌘Z)"
            >
              <Undo2 />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={!future.current.length}
              onClick={redo}
              aria-label="Redo (⇧⌘Z)"
              title="Redo (⇧⌘Z)"
            >
              <Redo2 />
            </Button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() => setFlow(JSON.parse(baseline))}
            title="Back to the last saved draft (undoable)"
          >
            Discard changes
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={save.state !== 'idle'}
            onClick={() => submit('save')}
          >
            <Save /> Save
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={save.state !== 'idle' || issues.errors.length > 0}
            onClick={() => (unpublished ? setConfirm('test') : submit('test'))}
            title={
              unpublished
                ? 'Publishes your changes as a new version, then starts a sample order on it'
                : `Starts a sample order on v${published}`
            }
          >
            <FlaskConical /> Test run
          </Button>
          <Button
            size="sm"
            disabled={save.state !== 'idle' || issues.errors.length > 0 || !unpublished}
            onClick={() => setConfirm('publish')}
            title={unpublished ? undefined : `Nothing to publish: v${published} is current`}
          >
            <Rocket /> Publish
          </Button>
        </div>
      </header>

      {blocker.state === 'blocked' ? (
        <div
          role="alertdialog"
          aria-label="Unsaved changes"
          className="flex flex-wrap items-center gap-3 border-b bg-wait/10 px-5 py-2 text-sm"
        >
          <span className="flex-1">This flow has unsaved changes. Leave without saving them?</span>
          <Button size="sm" variant="ghost" onClick={() => blocker.reset?.()} autoFocus>
            Stay
          </Button>
          <Button size="sm" variant="outline" onClick={() => blocker.proceed?.()}>
            Leave without saving
          </Button>
        </div>
      ) : null}

      {confirm ? (
        <div
          role="alertdialog"
          aria-label="Publish this flow"
          className="flex flex-wrap items-center gap-3 border-b bg-muted/60 px-5 py-2.5 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setConfirm(null);
          }}
        >
          <p className="min-w-0 flex-1">
            <span className="font-medium">
              {confirm === 'test'
                ? `A test run publishes v${(published ?? 0) + 1} first.`
                : `Publish v${(published ?? 0) + 1}?`}
            </span>{' '}
            <span className="text-muted-foreground">
              {publishedGraph
                ? `${changes.summary} since v${published}. `
                : 'This is the first version. '}
              New {ORDER_TYPE_LABELS[flow.orderType]} orders will run it; orders already running
              keep their version.
            </span>
          </p>
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            Not yet
          </Button>
          <Button
            size="sm"
            autoFocus
            onClick={() => {
              setConfirm(null);
              submit(confirm);
            }}
          >
            {confirm === 'test'
              ? `Publish v${(published ?? 0) + 1} and test`
              : `Publish v${(published ?? 0) + 1}`}
          </Button>
        </div>
      ) : null}

      <p className="border-b bg-muted/50 px-4 py-2 text-muted-foreground text-sm lg:hidden">
        Building flows needs a wider screen. Here you can review the graph and its settings.
      </p>

      <form
        className="hidden items-center gap-2 border-b bg-ai/[0.04] px-5 py-2 lg:flex"
        onSubmit={(e) => {
          e.preventDefault();
          if (!prompt.trim()) return;
          copilot.submit(JSON.stringify({ intent: 'copilot', prompt, flow }), {
            method: 'post',
            action: `/flows/${flow.id}/action`,
            encType: 'application/json',
          });
        }}
      >
        <Sparkles className="size-4 shrink-0 text-ai" />
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Ask the copilot to change this flow, e.g. “add a fraud check after credit”"
          aria-label="Ask the copilot to change this flow"
          className="h-8 border-ai/20 bg-transparent text-sm"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={copilot.state !== 'idle'}>
          {copilot.state !== 'idle' ? 'Thinking…' : 'Propose'}
        </Button>
      </form>

      {proposal && diff ? (
        <div className="flex flex-wrap items-center gap-3 border-b bg-ai/10 px-5 py-2 text-sm">
          <span className="text-ai">{proposal.explanation}</span>
          <span className="text-muted-foreground text-xs tabular">
            +{diff.added} / −{diff.removed} nodes, {diff.edges >= 0 ? '+' : ''}
            {diff.edges} connections
            {proposal.errors.length ? ` · ${proposal.errors.length} problems to fix` : ''}
          </span>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              onClick={() => {
                setGraph(proposal.graph);
                setProposal(null);
                setPrompt('');
              }}
            >
              Apply changes
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)_340px]">
        <aside className="hidden min-h-0 border-r p-3 lg:block">
          <Palette onPick={(t) => addNode(t)} />
        </aside>
        <div className="h-[60vh] min-h-[360px] p-3 lg:h-auto">
          <FlowCanvas
            graph={proposal ? proposal.graph : flow}
            editable={!proposal}
            issues={proposal ? undefined : nodeIssues}
            selectedId={selected}
            onSelect={setSelected}
            onChange={setGraph}
            onAddNode={(t, p) => addNode(t, p)}
          />
        </div>
        <aside className="min-h-0 overflow-y-auto border-t p-4 lg:border-t-0 lg:border-l">
          {node ? (
            <div className="space-y-6">
              <Inspector node={node} onChange={updateNode} onDelete={() => deleteNode(node.id)} />
              <Connections node={node} graph={flow} onChange={setGraph} />
            </div>
          ) : (
            <div className="space-y-5">
              <label className="block">
                <span className="section-title mb-1.5 block">Description</span>
                <textarea
                  value={flow.description}
                  onChange={(e) => setFlow({ ...flow, description: e.target.value })}
                  rows={4}
                  className="w-full rounded-md border border-input bg-transparent px-2 py-1.5 text-sm"
                />
              </label>
              <div>
                <h2 className="section-title mb-1.5">Checks</h2>
                {issues.errors.length === 0 ? (
                  <div className="flex items-center gap-1.5 text-ok text-sm">
                    <CheckCircle2 className="size-4" /> Ready to publish
                  </div>
                ) : null}
                <ul className="space-y-1.5">
                  {issues.errors.map((e, i) => (
                    <li key={`e${i}`}>
                      <button
                        type="button"
                        onClick={() => e.nodeId && setSelected(e.nodeId)}
                        className="flex gap-1.5 text-left text-bad text-sm hover:underline"
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {e.message}
                      </button>
                    </li>
                  ))}
                  {issues.warnings.map((e, i) => (
                    <li key={`w${i}`}>
                      <button
                        type="button"
                        onClick={() => e.nodeId && setSelected(e.nodeId)}
                        className="flex gap-1.5 text-left text-sm text-wait hover:underline"
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {e.message}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="max-w-[65ch] space-y-2 text-muted-foreground text-sm leading-relaxed">
                <p>
                  Drag nodes from the palette, connect an output dot to an input, and press Delete
                  to remove a selection. From the keyboard: Enter on a palette item adds it after
                  the selected node, and a node’s Connections list wires its outputs.
                </p>
                <p>
                  Branches are the labelled outputs on each node. To repeat steps, use a <b>Loop</b>{' '}
                  and connect the end of its body to the amber <b>next</b> input.
                </p>
                <p>
                  Publishing snapshots a new version. Running orders keep the version they started
                  on.
                </p>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

/** What publishing would change, counted against the published graph. */
function graphChanges(published: FlowGraph | null, current: FlowGraph) {
  if (!published) return { total: 1, summary: '' };
  const strip = (n: FlowNode) => JSON.stringify({ ...n, position: null });
  const before = new Map(published.nodes.map((n) => [n.id, strip(n)]));
  const after = new Map(current.nodes.map((n) => [n.id, strip(n)]));
  const added = [...after.keys()].filter((id) => !before.has(id)).length;
  const removed = [...before.keys()].filter((id) => !after.has(id)).length;
  const edited = [...after].filter(([id, v]) => before.has(id) && before.get(id) !== v).length;
  const eb = new Set(published.edges.map((e) => e.id));
  const ea = new Set(current.edges.map((e) => e.id));
  const rewired =
    [...ea].filter((id) => !eb.has(id)).length + [...eb].filter((id) => !ea.has(id)).length;
  const moved = current.nodes.some((n) => {
    const p = published.nodes.find((m) => m.id === n.id);
    return p && (p.position.x !== n.position.x || p.position.y !== n.position.y);
  });
  const parts = [
    added ? `${added} node${added === 1 ? '' : 's'} added` : '',
    removed ? `${removed} removed` : '',
    edited ? `${edited} edited` : '',
    rewired ? `${rewired} connection${rewired === 1 ? '' : 's'} changed` : '',
  ].filter(Boolean);
  return {
    total: added + removed + edited + rewired + (moved ? 1 : 0),
    summary: parts.length ? parts.join(', ') : 'Layout changes only',
  };
}
