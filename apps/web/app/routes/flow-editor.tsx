import {
  autoLayout,
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
  Rocket,
  Save,
  Sparkles,
  Undo2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { data, Link, useBlocker, useFetcher, useLoaderData, useNavigate } from 'react-router';
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
  const [flow, setFlow] = useState<Flow>(loaded.flow);
  const [baseline, setBaseline] = useState(() => JSON.stringify(loaded.flow));
  const [selected, setSelected] = useState<string | null>(null);
  const [published, setPublished] = useState(loaded.publishedVersion);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: react to new results only
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
      if (d.version) setPublished(d.version);
      setNotice({ tone: 'ok', text: d.version ? `Published v${d.version}` : 'Draft saved' });
      if (d.orderId) navigate(`/orders/${d.orderId}`);
    }
  }, [save.data, save.state]);

  useEffect(() => {
    if (copilot.state !== 'idle' || !copilot.data) return;
    if (copilot.data.error) setNotice({ tone: 'err', text: copilot.data.error });
    else setProposal(copilot.data);
  }, [copilot.data, copilot.state]);

  // ⌘S saves, Escape deselects.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        submit('save');
      }
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [submit]);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      currentLocation.pathname !== nextLocation.pathname &&
      !nextLocation.pathname.startsWith('/orders/'),
  );
  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm('Discard unsaved changes to this flow?')) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker]);

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
    <div className="flex h-[calc(100dvh-3rem)] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b px-5 py-2.5">
        <div className="min-w-0">
          <div className="text-muted-foreground text-xs">
            <Link to="/flows" className="hover:underline">
              Flows
            </Link>{' '}
            / <span className="font-mono">{flow.id}</span>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={flow.name}
              onChange={(e) => setFlow({ ...flow, name: e.target.value })}
              className="h-8 w-64 border-transparent bg-transparent px-1 font-semibold text-base hover:border-input"
              aria-label="Flow name"
            />
            <NativeSelect
              value={flow.orderType}
              onChange={(e) => setFlow({ ...flow, orderType: e.target.value as OrderType })}
              className="h-8 text-xs"
            >
              {ORDER_TYPES.map((t) => (
                <NativeSelectOption key={t} value={t}>
                  {ORDER_TYPE_LABELS[t]}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {published ? `live v${published}` : 'unpublished'}
            </span>
            {dirty ? (
              <span className="rounded bg-wait/15 px-1.5 py-0.5 text-[11px] text-wait">
                unsaved
              </span>
            ) : null}
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {notice ? (
            <span
              className={cn(
                'text-xs',
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
          <Button
            variant="ghost"
            size="sm"
            disabled={!dirty}
            onClick={() => setFlow(JSON.parse(baseline))}
          >
            <Undo2 /> Discard
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
            onClick={() => submit('test')}
            title="Publish and start a sample order"
          >
            <FlaskConical /> Test run
          </Button>
          <Button
            size="sm"
            disabled={save.state !== 'idle' || issues.errors.length > 0}
            onClick={() => submit('publish')}
          >
            <Rocket /> Publish
          </Button>
        </div>
      </header>

      <form
        className="flex items-center gap-2 border-b bg-ai/[0.04] px-5 py-2"
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
          placeholder="Ask the copilot: “add a fraud risk score after credit and send high risk to approval”"
          className="h-8 border-ai/20 bg-transparent text-sm"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={copilot.state !== 'idle'}>
          {copilot.state !== 'idle' ? 'Thinking…' : 'Propose'}
        </Button>
      </form>

      {proposal && diff ? (
        <div className="flex flex-wrap items-center gap-3 border-b bg-ai/10 px-5 py-2 text-sm">
          <span className="text-ai">{proposal.explanation}</span>
          <span className="text-muted-foreground text-xs">
            +{diff.added} / −{diff.removed} nodes, {diff.edges >= 0 ? '+' : ''}
            {diff.edges} edges{proposal.errors.length ? ` · ${proposal.errors.length} issues` : ''}
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
              Apply
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setProposal(null)}>
              Discard
            </Button>
          </div>
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 lg:grid-cols-[220px_minmax(0,1fr)_340px]">
        <aside className="hidden min-h-0 border-r p-3 lg:block">
          <Palette onPick={(t) => addNode(t)} />
        </aside>
        <div className="min-h-[420px] p-3">
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
        <aside className="min-h-0 overflow-y-auto border-l p-4">
          {node ? (
            <Inspector node={node} onChange={updateNode} onDelete={() => deleteNode(node.id)} />
          ) : (
            <div className="space-y-4">
              <div>
                <div className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  Description
                </div>
                <textarea
                  value={flow.description}
                  onChange={(e) => setFlow({ ...flow, description: e.target.value })}
                  rows={4}
                  className="w-full rounded-md border bg-transparent px-2 py-1.5 text-xs"
                />
              </div>
              <div>
                <div className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
                  Validation
                </div>
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
                        className="flex gap-1.5 text-left text-bad text-xs"
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
                        className="flex gap-1.5 text-left text-wait/90 text-xs"
                      >
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" /> {e.message}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="text-muted-foreground text-xs leading-relaxed">
                <p>
                  Drag nodes from the palette, connect an output dot to an input, and press Delete
                  to remove a selection.
                </p>
                <p className="mt-2">
                  Branches are the labelled outputs on each node. To repeat steps, use a <b>Loop</b>{' '}
                  and connect the end of its body to the amber <b>next</b> input.
                </p>
                <p className="mt-2">
                  Publishing snapshots a new version. Running orders keep the version they started
                  on.
                </p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setFlow((f) => autoLayout(f))}>
                Tidy layout
              </Button>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
