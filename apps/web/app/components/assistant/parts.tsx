/**
 * How the assistant's messages read: prose, its thinking and the tools it read with as Trace lines,
 * actions waiting for a person as confirm cards that state the resolved consequence, and flow
 * proposals that hand off to the editor. A declined action is neutral (the person chose it), never
 * a failure.
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
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@orderloop/ui/card';
import { Item, ItemContent, ItemDescription, ItemTitle } from '@orderloop/ui/item';
import { cn } from '@orderloop/ui/lib/utils';
import {
  type DynamicToolUIPart,
  getToolName,
  isToolUIPart,
  type ToolUIPart,
  type UIMessage,
} from 'ai';
import {
  ArrowDown,
  ArrowUpRight,
  Ban,
  Boxes,
  Brain,
  CircleAlert,
  FileText,
  Inbox,
  Library,
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
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from '~/components/ai-elements/trace';
import { useAssistant } from '~/lib/assistant';
import { plural } from '~/lib/format';

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
  assess_order: 'Assessing the order',
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
      return total
        ? `${plural(c.approvals, 'approval')} · ${c.failed} failed · ${c.stalled} stalled`
        : null;
    }
    case 'find_orders':
      return `${out.count} found · ${out.total}`;
    case 'get_order':
      // Where the order is in its flow, not only its status.
      return `${out.ref} · ${whereAt(out) ?? statusWords(out.status)}`;
    case 'find_products':
      return plural(n(out.products), 'product');
    case 'list_carts':
      return plural(n(out.carts), 'cart');
    case 'get_cart':
    case 'create_cart':
    case 'change_cart':
      return `${plural(n(out.lines), 'line')}${out.priced && out.total ? ` · ${out.total}` : ''}`;
    case 'list_flows':
      return plural(n(out.flows), 'flow');
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

/**
 * A tool the assistant used to read, as one Trace line: what it is doing while the turn streams,
 * then what it found. An order read links to its step. A read that failed, or that the turn left
 * unfinished, says so in `bad` and opens to show why.
 */
export function ReadLine({ part, streaming }: { part: Part; streaming: boolean }) {
  const name = getToolName(part);
  const Icon = ICONS[name] ?? Search;
  const label = isAssistantTool(name) ? ASSISTANT_TOOLS[name].label : name;
  const doing = RUNNING[name] ?? label;
  const unfinished = part.state === 'input-streaming' || part.state === 'input-available';
  if (unfinished && streaming)
    return (
      <TraceLine status="running">
        <TraceIcon>
          <Icon />
        </TraceIcon>
        <TraceTitle>{doing}</TraceTitle>
      </TraceLine>
    );
  if (unfinished || part.state === 'output-error')
    return (
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine status="error">
            <TraceIcon>
              <CircleAlert />
            </TraceIcon>
            <TraceTitle>
              {doing} {unfinished ? 'stopped' : 'failed'}
            </TraceTitle>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          {part.state === 'output-error' ? part.errorText : 'The reply ended before this finished.'}
        </TraceCollapsibleContent>
      </TraceCollapsible>
    );
  const out =
    part.state === 'output-available' ? ((part.output ?? {}) as Record<string, unknown>) : null;
  const result = out ? found(name, out) : null;
  const record = out ? recordOf(name, out) : null;
  const node = out && name === 'get_order' ? focusNode(out) : null;
  const href = record ? `${record.href}${node ? `?node=${encodeURIComponent(node)}` : ''}` : null;
  const line = (
    <TraceLine>
      <TraceIcon>
        <Icon />
      </TraceIcon>
      {/* The label is short and stays whole; a long result truncates instead. */}
      <TraceTitle className="shrink-0">{label}</TraceTitle>
      {result ? (
        <TraceDescription className="min-w-0 shrink truncate text-foreground/80">
          {result}
        </TraceDescription>
      ) : null}
    </TraceLine>
  );
  return href ? (
    <Link to={href} className="hit-area">
      {line}
    </Link>
  ) : (
    line
  );
}

// ── Sources ────────────────────────────────────────────────────────────────

/** A record the assistant opened to answer: an order, cart or flow, with where it lives. */
export type Source = { href: string; label: string };

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** The one record a read opened, if it opened one (a search or list is many, linked in the reply). */
function recordOf(name: string, out: Record<string, unknown>): Source | null {
  switch (name) {
    case 'get_order':
      return str(out.href) ? { href: str(out.href), label: words(out.ref, out.title) } : null;
    case 'assess_order':
      return str(out.id) ? { href: `/orders/${str(out.id)}`, label: words(out.ref) } : null;
    case 'get_cart':
    case 'create_cart':
    case 'change_cart':
      return str(out.href) ? { href: str(out.href), label: words(out.title || out.id) } : null;
    case 'get_flow':
      return str(out.href) ? { href: str(out.href), label: words(out.name) } : null;
    default:
      return null;
  }
}

const words = (...v: unknown[]) => v.map(str).filter(Boolean).join(' · ');

/** The distinct records a message's reads opened, in the order it opened them. */
export function sourcesOf(parts: UIMessage['parts']): Source[] {
  const seen = new Map<string, Source>();
  for (const p of parts) {
    if (!isToolUIPart(p) || p.state !== 'output-available') continue;
    const r = recordOf(getToolName(p), (p.output ?? {}) as Record<string, unknown>);
    if (r && !seen.has(r.href)) seen.set(r.href, r);
  }
  return [...seen.values()];
}

/** What a reply drew on, as one line that opens on a link to each record. */
export function SourcesLine({ sources }: { sources: readonly Source[] }) {
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine>
          <TraceIcon>
            <Library />
          </TraceIcon>
          <TraceTitle>Used {plural(sources.length, 'record')}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <ul className="flex flex-col">
          {sources.map((s) => (
            <Item
              asChild
              key={s.href}
              size="xs"
              className="relative flex-nowrap px-2 py-1 hover:bg-muted/60 touch:min-h-11"
            >
              <li>
                <ItemContent className="min-w-0">
                  <ItemTitle className="w-full font-normal text-[12.5px]">
                    <Link
                      to={s.href}
                      className="truncate text-foreground/80 after:absolute after:inset-0 after:rounded-2xl hover:text-foreground hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]"
                    >
                      {s.label || s.href}
                    </Link>
                  </ItemTitle>
                </ItemContent>
              </li>
            </Item>
          ))}
        </ul>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

/**
 * The model's thinking before it answered, as one line that opens to show it. It shimmers while
 * the thinking streams and stays a plain line until there is text to show.
 */
export function ReasoningLine({ text, running }: { text: string; running: boolean }) {
  const line = (
    <TraceLine status={running ? 'running' : undefined}>
      <TraceIcon>
        <Brain />
      </TraceIcon>
      <TraceTitle>{running ? 'Thinking' : 'Thought'}</TraceTitle>
    </TraceLine>
  );
  if (!text.trim()) return line;
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="whitespace-pre-wrap">
        {text.trim()}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

// ── Actions that wait for a person ─────────────────────────────────────────

/** `callId` is the tool call the card is for: the engine holds the confirm to what this card showed. */
export type Previewer = (tool: string, input: unknown, callId: string) => Promise<ActionPreview>;

const DESTRUCTIVE = (name: string, input: Record<string, unknown>) =>
  name === 'cancel_order' ||
  ((name === 'decide_approval' || name === 'decide_approvals') && input.decision === 'rejected');

const VERB: Record<string, (input: Record<string, unknown>) => string> = {
  decide_approval: (i) => (i.decision === 'rejected' ? 'Reject' : 'Approve'),
  decide_approvals: (i) => (i.decision === 'rejected' ? 'Reject all' : 'Approve all'),
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

  // Settled: one Trace line, in the words of what happened.
  if (!asking) {
    const title = p?.title ?? fallbackTitle;
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
          {title}: left as it was. You declined.
        </Settled>
      );
    if (part.state === 'output-error')
      return (
        <TraceCollapsible defaultOpen>
          <TraceCollapsibleTrigger>
            <TraceLine status="error">
              <TraceIcon>
                <CircleAlert />
              </TraceIcon>
              <TraceTitle>{title} didn’t go through</TraceTitle>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent>{part.errorText}</TraceCollapsibleContent>
        </TraceCollapsible>
      );
    if (out?.done)
      return (
        <Settled icon={ArrowUpRight} tone="ink" href={out.href}>
          {out.done}
        </Settled>
      );
    return (
      <TraceLine status="running">
        <TraceIcon>
          <ArrowUpRight />
        </TraceIcon>
        <TraceTitle>{title}</TraceTitle>
      </TraceLine>
    );
  }

  const approvalId = part.approval?.id;
  const verb = actionVerb(name, input);
  const blocked = p?.blocked;
  // No `overflow-hidden` on the card: it would clip the buttons' touch areas (`hit-area`). Escape
  // leaves the card as it does anywhere else; declining is always a button press.
  return (
    <Confirmation
      approval={part.approval}
      state={part.state}
      aria-labelledby={titleId}
      data-action={actionKey}
      className="ol-confirm my-1 scroll-my-4"
    >
      <Card size="sm" className="gap-3 overflow-visible pb-0">
        <CardHeader>
          <CardTitle>
            <h3 id={titleId} className="min-w-0 font-semibold text-sm leading-snug">
              {p?.title ?? fallbackTitle}
            </h3>
          </CardTitle>
          {p?.href ? (
            <CardAction>
              <Link
                to={p.href}
                className="hit-area text-link text-xs hover:underline"
                aria-label={`Open ${p.title}`}
              >
                Open
              </Link>
            </CardAction>
          ) : null}
        </CardHeader>
        {p ? (
          p.consequences.length ? (
            <CardContent>
              <ul className="-mx-3 flex flex-col tabular">
                {p.consequences.map((c) => (
                  <Item asChild key={c} size="xs" className="py-1.5">
                    <li>
                      <ItemContent className="min-w-0 text-ui leading-snug">{c}</ItemContent>
                    </li>
                  </Item>
                ))}
              </ul>
            </CardContent>
          ) : null
        ) : (
          <CardContent>
            <p className="text-muted-foreground text-xs">
              {loadError
                ? `Couldn’t check this against the order: ${loadError}`
                : 'Checking what this will do'}
              {loadError ? null : <span aria-hidden="true" className="ol-dots" />}
            </p>
          </CardContent>
        )}
        <CardFooter className="flex-col items-stretch gap-2 rounded-b-2xl border-t bg-muted/40 pb-(--card-spacing)">
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
        </CardFooter>
      </Card>
    </Confirmation>
  );
}

/** A finished thing as a Trace line that wraps rather than truncates: its words can be a sentence. */
function Settled({
  icon: Icon,
  tone,
  href,
  children,
}: {
  icon: LucideIcon;
  tone: 'ink' | 'muted';
  href?: string;
  children: React.ReactNode;
}) {
  const line = (
    <TraceLine
      className={cn(
        'items-start text-ui leading-snug',
        tone === 'ink' && 'font-medium text-foreground',
      )}
    >
      <TraceIcon className="mt-0.5">
        <Icon />
      </TraceIcon>
      <span className="min-w-0">{children}</span>
    </TraceLine>
  );
  return href ? (
    <Link to={href} className="hit-area hover:underline">
      {line}
    </Link>
  ) : (
    line
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
export function PluginDraftCard({ part, streaming }: { part: Part; streaming: boolean }) {
  const navigate = useNavigate();
  const titleId = useId();
  if (part.state !== 'output-available')
    return (
      <Trace>
        <ReadLine part={part} streaming={streaming} />
      </Trace>
    );
  const d = part.output as PluginDraftResult;
  const allPass = d.cases.total > 0 && d.cases.passed === d.cases.total;
  return (
    <section aria-labelledby={titleId} className="my-1">
      <Card size="sm" className="gap-3 overflow-visible pb-0">
        <CardHeader>
          <CardTitle>
            <h3
              id={titleId}
              className="flex items-baseline gap-2 font-semibold text-sm leading-snug"
            >
              <AiDot />
              <span className="min-w-0">
                Drafted {d.name}{' '}
                <span className="font-normal text-muted-foreground text-xs">
                  version {d.version}
                </span>
              </span>
            </h3>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5">
          <p className="text-ui leading-snug">{d.explanation}</p>
          {d.nodes.length ? (
            <ul className="-mx-3 flex flex-col">
              {d.nodes.map((n) => (
                <Item asChild key={n.type} size="xs" className="flex-nowrap py-1">
                  <li>
                    <ItemContent className="min-w-0 gap-0">
                      <ItemTitle className="font-normal text-xs">{n.label}</ItemTitle>
                      <ItemDescription className="truncate text-xs">
                        <code>{n.type}</code>
                      </ItemDescription>
                    </ItemContent>
                  </li>
                </Item>
              ))}
            </ul>
          ) : null}
          <p className={cn('text-xs tabular', allPass ? 'text-muted-foreground' : 'text-wait')}>
            {draftStatus(d)}
          </p>
        </CardContent>
        <CardFooter className="gap-2 rounded-b-2xl border-t bg-muted/40 pb-(--card-spacing)">
          <p className="min-w-0 flex-1 text-muted-foreground text-xs">
            Nothing runs until an admin approves it.
          </p>
          <Button size="sm" onClick={() => navigate(d.href)}>
            Review
          </Button>
        </CardFooter>
      </Card>
    </section>
  );
}

// ── Flow proposals ─────────────────────────────────────────────────────────

/** A drafted flow change. Applying happens in the editor, where undo and publish already live. */
export function ProposalCard({ part, streaming }: { part: Part; streaming: boolean }) {
  const { offerProposal } = useAssistant();
  const navigate = useNavigate();
  const titleId = useId();
  if (part.state !== 'output-available')
    return (
      <Trace>
        <ReadLine part={part} streaming={streaming} />
      </Trace>
    );
  const pr = part.output as FlowProposal;
  const diff = describeDiff(pr.changes);
  // Nothing drafted: say so, and offer nothing to review.
  if (!diff)
    return (
      <Trace>
        <Settled icon={PenLine} tone="muted">
          No change drafted for {pr.flowName}. {pr.explanation}
        </Settled>
      </Trace>
    );
  return (
    <section aria-labelledby={titleId} className="my-1">
      <Card size="sm" className="gap-3 overflow-visible pb-0">
        <CardHeader>
          <CardTitle>
            <h3
              id={titleId}
              className="flex items-baseline gap-2 font-semibold text-sm leading-snug"
            >
              <AiDot />
              <span className="min-w-0">Proposed change to {pr.flowName}</span>
            </h3>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-1.5">
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
        </CardContent>
        <CardFooter className="gap-2 rounded-b-2xl border-t bg-muted/40 pb-(--card-spacing)">
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
        </CardFooter>
      </Card>
    </section>
  );
}
