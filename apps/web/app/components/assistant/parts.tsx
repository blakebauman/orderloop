/**
 * How the assistant's messages read: prose, the tools it used as ruled rows, actions waiting for a
 * person as confirm cards that state the resolved consequence, and flow proposals that hand off to
 * the editor. A declined action is neutral (the person chose it), never a failure.
 */

import {
  type ActionPreview,
  ASSISTANT_TOOLS,
  describeDiff,
  type FlowProposal,
  isAssistantTool,
  type PluginDraftResult,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import { type DynamicToolUIPart, getToolName, type ToolUIPart } from 'ai';
import {
  ArrowDown,
  ArrowUpRight,
  Ban,
  Boxes,
  CircleAlert,
  FileText,
  Inbox,
  type LucideIcon,
  PenLine,
  Puzzle,
  Search,
  ShoppingCart,
  Workflow,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Confirmation, ConfirmationActions } from '~/components/ai-elements/confirmation';
import { MessageResponse } from '~/components/ai-elements/message';
import { useAssistant } from '~/lib/assistant';

type Part = ToolUIPart | DynamicToolUIPart;

// ── Prose ──────────────────────────────────────────────────────────────────

/** Markdown from the model. Links inside the app navigate in place; the panel stays open. */
export function Prose({ text, streaming }: { text: string; streaming?: boolean }) {
  const navigate = useNavigate();
  return (
    <MessageResponse
      className="ol-prose"
      mode={streaming ? 'streaming' : 'static'}
      isAnimating={streaming}
      controls={false}
      components={{
        a: ({ href, children }) => {
          const internal =
            typeof href === 'string' && href.startsWith('/') && !href.startsWith('//');
          return internal ? (
            <a
              href={href}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                e.preventDefault();
                navigate(href);
              }}
            >
              {children}
            </a>
          ) : (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          );
        },
      }}
    >
      {text}
    </MessageResponse>
  );
}

// ── Reads ──────────────────────────────────────────────────────────────────

const ICONS: Record<string, LucideIcon> = {
  needs_attention: Inbox,
  find_orders: Search,
  get_order: FileText,
  find_products: Boxes,
  list_carts: ShoppingCart,
  get_cart: ShoppingCart,
  create_cart: ShoppingCart,
  change_cart: ShoppingCart,
  list_flows: Workflow,
  get_flow: Workflow,
  propose_flow_change: PenLine,
  draft_plugin: Puzzle,
  draft_product_content: PenLine,
};

const RUNNING: Record<string, string> = {
  needs_attention: 'Checking what needs attention',
  find_orders: 'Searching orders',
  get_order: 'Reading the order',
  find_products: 'Looking up stock',
  list_carts: 'Listing carts',
  get_cart: 'Reading the cart',
  create_cart: 'Opening a cart',
  change_cart: 'Changing the cart',
  list_flows: 'Listing flows',
  get_flow: 'Reading the flow',
  propose_flow_change: 'Drafting a flow change',
  draft_plugin: 'Drafting a plugin',
  draft_product_content: 'Drafting product content',
};

const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** One line saying what a read found. */
function found(name: string, out: Record<string, unknown>): string | null {
  switch (name) {
    case 'needs_attention': {
      const c = out.counts as { approvals: number; failed: number; stalled: number } | undefined;
      if (!c) return null;
      const total = c.approvals + c.failed + c.stalled;
      // Nothing waiting is already said by the attention line above the conversation.
      return total ? `${c.approvals} approvals · ${c.failed} failed · ${c.stalled} stalled` : null;
    }
    case 'find_orders':
      return `${out.count} found · ${out.total}`;
    case 'get_order':
      // Where the order is in its flow, not only its status.
      return `${out.ref} · ${whereAt(out) ?? statusWords(out.status)}`;
    case 'find_products':
      return `${n(out.products)} products`;
    case 'list_carts':
      return `${n(out.carts)} carts`;
    case 'get_cart':
    case 'create_cart':
    case 'change_cart':
      return `${n(out.lines)} lines${out.priced && out.total ? ` · ${out.total}` : ''}`;
    case 'list_flows':
      return `${n(out.flows)} flows`;
    case 'get_flow':
      return typeof out.name === 'string' ? out.name : null;
    case 'draft_product_content':
      return `${out.title} · ${n(out.drafted)} drafted${n(out.refused) ? ` · ${n(out.refused)} not` : ''}`;
    default:
      return null;
  }
}

export const statusWords = (s: unknown) => String(s ?? '').replaceAll('_', ' ');

type Wait = { nodeId: string; step?: string; since?: string };
type Step = { nodeId: string; step: string; status: string };
const list = <T,>(v: unknown) => (Array.isArray(v) ? (v as T[]) : []);

/** Where an order is held ("waiting at Credit approval, 2h") or stopped ("failed at Charge"). */
function whereAt(out: Record<string, unknown>): string | null {
  const w = list<Wait>(out.waits).find((x) => x.step);
  if (w) return `waiting at ${w.step}${w.since ? `, ${age(w.since)}` : ''}`;
  const stopped = list<Step>(out.steps).find((x) => x.status === 'failed');
  return stopped ? `${statusWords(out.status)} at ${stopped.step}` : null;
}

/** The node an order read opens on the order's graph: the step it waits at or failed at. */
function focusNode(out: Record<string, unknown>): string | null {
  return (
    list<Wait>(out.waits)[0]?.nodeId ??
    list<Step>(out.steps).find((x) => x.status === 'failed')?.nodeId ??
    null
  );
}

function age(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (Number.isNaN(mins)) return '';
  if (mins < 60) return `${mins}m`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** A tool the assistant used to read, as one ruled row. An order read links to its step. */
export function ReadRow({ part }: { part: Part }) {
  const name = getToolName(part);
  const Icon = ICONS[name] ?? Search;
  const label = isAssistantTool(name) ? ASSISTANT_TOOLS[name].label : name;
  const running = part.state === 'input-streaming' || part.state === 'input-available';
  const failed = part.state === 'output-error';
  const out =
    part.state === 'output-available' ? ((part.output ?? {}) as Record<string, unknown>) : null;
  const result = out ? found(name, out) : null;
  const node = out && name === 'get_order' ? focusNode(out) : null;
  const href =
    out && name === 'get_order' && typeof out.href === 'string'
      ? `${out.href}${node ? `?node=${encodeURIComponent(node)}` : ''}`
      : null;
  return (
    <div className="flex min-h-7 items-center gap-2 border-rule border-y border-dashed py-1 text-[12.5px] text-muted-foreground [&+&]:border-t-0">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {running ? (
        <span className="flex items-center gap-1.5">
          {RUNNING[name] ?? label}
          <span aria-hidden="true" className="ol-dots" />
        </span>
      ) : (
        // The label is short and stays whole; a long result truncates instead.
        <span className="shrink-0">{label}</span>
      )}
      {result && href ? (
        <Link
          to={href}
          className="hit-area ml-auto min-w-0 truncate text-foreground/80 tabular hover:text-foreground hover:underline"
        >
          {result}
        </Link>
      ) : result ? (
        <span className="ml-auto min-w-0 truncate text-foreground/80 tabular">{result}</span>
      ) : null}
      {failed ? (
        <span className="ml-auto min-w-0 truncate text-bad" title={part.errorText}>
          {part.errorText}
        </span>
      ) : null}
    </div>
  );
}

// ── Actions that wait for a person ─────────────────────────────────────────

/** `callId` is the tool call the card is for: the engine holds the confirm to what this card showed. */
export type Previewer = (tool: string, input: unknown, callId: string) => Promise<ActionPreview>;

const DESTRUCTIVE = (name: string, input: Record<string, unknown>) =>
  name === 'cancel_order' || (name === 'decide_approval' && input.decision === 'rejected');

const VERB: Record<string, (input: Record<string, unknown>) => string> = {
  decide_approval: (i) => (i.decision === 'rejected' ? 'Reject' : 'Approve'),
  deliver_event: () => 'Deliver event',
  cancel_order: () => 'Cancel order',
  submit_cart: () => 'Submit cart',
  publish_flow: () => 'Publish',
  run_stock_review: () => 'Run review',
};

/** The confirm button's word for an action, e.g. "Approve" or "Run review". */
export const actionVerb = (name: string, input: unknown) =>
  VERB[name]?.((input ?? {}) as Record<string, unknown>) ?? 'Confirm';

/**
 * An action the assistant prepared. Before anything is sent the card states what will happen,
 * resolved against live data; one press confirms it. Focus starts on the safe choice when the
 * person is already in the conversation, never pulled out of the composer. A card that a newer,
 * identical request replaced stops asking, so only one button can do the thing.
 */
export function ActionCard({
  part,
  preview,
  respond,
  actionKey,
  replaced,
}: {
  part: Part;
  preview: Previewer;
  respond: (approvalId: string, approved: boolean) => void;
  /** Unique in the conversation (`actionKey`); a tool call id need not be. */
  actionKey: string;
  replaced?: boolean;
}) {
  const name = getToolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  const [p, setP] = useState<ActionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const titleId = useId();
  const safe = useRef<HTMLButtonElement>(null);
  const asking = part.state === 'approval-requested' && !replaced;
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    if (!asking) return;
    let live = true;
    preview(name, input, part.toolCallId)
      .then((r) => live && setP(r))
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [asking, name, inputKey, preview, part.toolCallId]);

  useEffect(() => {
    if (!asking || !p || p.blocked) return;
    const el = safe.current;
    const now = document.activeElement;
    const inLog = !now || now === document.body || el?.closest('[role="log"]')?.contains(now);
    if (inLog) el?.focus({ preventScroll: true });
  }, [asking, p]);

  const fallbackTitle = isAssistantTool(name) ? ASSISTANT_TOOLS[name].label : name;

  if (replaced && part.state === 'approval-requested')
    return (
      <Settled icon={ArrowDown} tone="muted">
        {fallbackTitle}: replaced by the newer request below.
      </Settled>
    );

  // Settled: one ruled line, in the words of what happened.
  if (!asking) {
    const out = (part.state === 'output-available' ? part.output : null) as {
      done?: string;
      href?: string;
    } | null;
    if (
      part.state === 'output-denied' ||
      (part.state === 'approval-responded' && part.approval?.approved === false)
    )
      return (
        <Settled icon={Ban} tone="muted">
          {p?.title ?? fallbackTitle}: left as it was. You declined.
        </Settled>
      );
    if (part.state === 'output-error')
      return (
        <Settled icon={CircleAlert} tone="bad">
          {p?.title ?? fallbackTitle} didn’t go through. {part.errorText}
        </Settled>
      );
    if (out?.done)
      return (
        <Settled icon={ArrowUpRight} tone="ink" href={out.href}>
          {out.done}
        </Settled>
      );
    return (
      <Settled icon={ArrowUpRight} tone="muted">
        {p?.title ?? fallbackTitle}
        <span aria-hidden="true" className="ol-dots" />
      </Settled>
    );
  }

  const approvalId = part.approval?.id;
  const verb = actionVerb(name, input);
  const blocked = p?.blocked;
  // No `overflow-hidden`: it would clip the buttons' touch areas (`hit-area`). Escape leaves the
  // card as it does anywhere else; declining is always a button press.
  return (
    <Confirmation
      approval={part.approval}
      state={part.state}
      aria-labelledby={titleId}
      data-action={actionKey}
      className="ol-confirm my-1 scroll-my-4 rounded-2xl border border-input bg-card text-sm"
    >
      <div className="flex items-baseline gap-2 border-b px-3 py-2">
        <h3 id={titleId} className="min-w-0 flex-1 font-semibold leading-snug">
          {p?.title ?? fallbackTitle}
        </h3>
        {p?.href ? (
          <Link
            to={p.href}
            className="hit-area shrink-0 text-link text-xs hover:underline"
            aria-label={`Open ${p.title}`}
          >
            Open
          </Link>
        ) : null}
      </div>
      {p ? (
        p.consequences.length ? (
          <ul className="divide-y divide-dashed px-3 tabular">
            {p.consequences.map((c) => (
              <li key={c} className="py-1.5 text-ui leading-snug">
                {c}
              </li>
            ))}
          </ul>
        ) : null
      ) : (
        <p className="px-3 py-2 text-muted-foreground text-xs">
          {loadError
            ? `Couldn’t check this against the order: ${loadError}`
            : 'Checking what this will do'}
          {loadError ? null : <span aria-hidden="true" className="ol-dots" />}
        </p>
      )}
      <div className="space-y-2 rounded-b-2xl border-t bg-muted/40 px-3 py-2">
        {blocked ? (
          <p className="text-ui text-wait leading-snug">{blocked}</p>
        ) : (
          <p className="text-muted-foreground text-xs leading-snug">
            Nothing is sent until you confirm, here or wherever else you’re signed in.
          </p>
        )}
        <ConfirmationActions>
          <Button
            ref={safe}
            size="sm"
            variant="ghost"
            disabled={!approvalId || sent}
            onClick={() => {
              setSent(true);
              respond(approvalId!, false);
            }}
          >
            {blocked ? 'Dismiss' : 'Not now'}
          </Button>
          {blocked ? null : (
            <Button
              size="sm"
              variant={DESTRUCTIVE(name, input) ? 'destructive' : 'default'}
              disabled={!approvalId || !p || sent}
              onClick={() => {
                setSent(true);
                respond(approvalId!, true);
              }}
            >
              {verb}
            </Button>
          )}
        </ConfirmationActions>
      </div>
    </Confirmation>
  );
}

function Settled({
  icon: Icon,
  tone,
  href,
  children,
}: {
  icon: LucideIcon;
  tone: 'ink' | 'muted' | 'bad';
  href?: string;
  children: React.ReactNode;
}) {
  const body = (
    <>
      <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </>
  );
  const cls = cn(
    'flex items-start gap-2 border-y py-1.5 text-ui leading-snug',
    tone === 'ink' && 'font-medium text-foreground',
    tone === 'muted' && 'text-muted-foreground',
    tone === 'bad' && 'text-bad',
  );
  return href ? (
    <Link to={href} className={cn(cls, 'hover:underline')}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

/** Marks something a model drafted, in the `ai` colour (the same dot as "Working on it"). */
function AiDot() {
  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 translate-y-[-0.1em] self-center rounded-full bg-ai"
    />
  );
}

// ── Plugin drafts ──────────────────────────────────────────────────────────

/** What a draft's footer says: whether its cases pass, and that nothing runs yet. */
export function draftStatus(d: Pick<PluginDraftResult, 'cases'>): string {
  const { total, passed } = d.cases;
  if (!total) return 'It has no test cases yet: add some on the Plugins page.';
  return passed === total
    ? `All ${total} test cases pass.`
    : `${passed} of ${total} test cases pass: fix them before approving.`;
}

/** A drafted plugin. Reviewing, testing and approving happen on the Plugins page. */
export function PluginDraftCard({ part }: { part: Part }) {
  const navigate = useNavigate();
  if (part.state !== 'output-available') return <ReadRow part={part} />;
  const d = part.output as PluginDraftResult;
  const allPass = d.cases.total > 0 && d.cases.passed === d.cases.total;
  return (
    <section className="my-1 rounded-2xl border border-input bg-card text-sm">
      <div className="border-b px-3 py-2">
        <h3 className="flex items-baseline gap-2 font-semibold leading-snug">
          <AiDot />
          Drafted {d.name}{' '}
          <span className="font-normal text-muted-foreground text-xs">version {d.version}</span>
        </h3>
      </div>
      <div className="space-y-1.5 px-3 py-2">
        <p className="text-ui leading-snug">{d.explanation}</p>
        <ul className="text-muted-foreground text-xs">
          {d.nodes.map((n) => (
            <li key={n.type}>
              {n.label} <code>{n.type}</code>
            </li>
          ))}
        </ul>
        <p className={cn('text-xs tabular', allPass ? 'text-muted-foreground' : 'text-wait')}>
          {draftStatus(d)}
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-b-2xl border-t bg-muted/40 px-3 py-2">
        <p className="min-w-0 flex-1 text-muted-foreground text-xs">
          Nothing runs until an admin approves it.
        </p>
        <Button size="sm" onClick={() => navigate(d.href)}>
          Review
        </Button>
      </div>
    </section>
  );
}

// ── Flow proposals ─────────────────────────────────────────────────────────

/** A drafted flow change. Applying happens in the editor, where undo and publish already live. */
export function ProposalCard({ part }: { part: Part }) {
  const { offerProposal } = useAssistant();
  const navigate = useNavigate();
  if (part.state !== 'output-available') return <ReadRow part={part} />;
  const pr = part.output as FlowProposal;
  const diff = describeDiff(pr.changes);
  // Nothing drafted: say so, and offer nothing to review.
  if (!diff)
    return (
      <Settled icon={PenLine} tone="muted">
        No change drafted for {pr.flowName}. {pr.explanation}
      </Settled>
    );
  return (
    <section className="my-1 rounded-2xl border border-input bg-card text-sm">
      <div className="border-b px-3 py-2">
        <h3 className="flex items-baseline gap-2 font-semibold leading-snug">
          <AiDot />
          Proposed change to {pr.flowName}
        </h3>
      </div>
      <div className="space-y-1.5 px-3 py-2">
        <p className="text-ui leading-snug">{pr.explanation}</p>
        <p className="text-muted-foreground text-xs tabular">
          {diff}
          {pr.errors.length ? (
            <span className="text-bad">
              {' '}
              · {pr.errors.length} problem{pr.errors.length === 1 ? '' : 's'} to fix
            </span>
          ) : null}
          {pr.warnings.length ? (
            <span className="text-wait"> · {pr.warnings.length} to check</span>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-2 rounded-b-2xl border-t bg-muted/40 px-3 py-2">
        <p className="min-w-0 flex-1 text-muted-foreground text-xs">
          Nothing changes until you apply it.
        </p>
        <Button
          size="sm"
          onClick={() => {
            offerProposal(pr);
            if (!window.location.pathname.startsWith(`/flows/${pr.flowId}`))
              navigate(`/flows/${pr.flowId}`);
          }}
        >
          Review in editor
        </Button>
      </div>
    </section>
  );
}
