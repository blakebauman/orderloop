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
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import { type DynamicToolUIPart, getToolName, type ToolUIPart } from 'ai';
import {
  ArrowUpRight,
  Ban,
  Boxes,
  CircleAlert,
  FileText,
  Inbox,
  type LucideIcon,
  PenLine,
  Search,
  Workflow,
} from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Streamdown } from 'streamdown';
import { useAssistant } from '~/lib/assistant';

type Part = ToolUIPart | DynamicToolUIPart;

// ── Prose ──────────────────────────────────────────────────────────────────

/** Markdown from the model. Links inside the app navigate in place; the panel stays open. */
export function Prose({ text, streaming }: { text: string; streaming?: boolean }) {
  const navigate = useNavigate();
  return (
    <Streamdown
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
    </Streamdown>
  );
}

// ── Reads ──────────────────────────────────────────────────────────────────

const ICONS: Record<string, LucideIcon> = {
  needs_attention: Inbox,
  find_orders: Search,
  get_order: FileText,
  find_products: Boxes,
  list_flows: Workflow,
  get_flow: Workflow,
  propose_flow_change: PenLine,
};

const RUNNING: Record<string, string> = {
  needs_attention: 'Checking what needs attention',
  find_orders: 'Searching orders',
  get_order: 'Reading the order',
  find_products: 'Looking up stock',
  list_flows: 'Listing flows',
  get_flow: 'Reading the flow',
  propose_flow_change: 'Drafting a flow change',
};

const n = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** One line saying what a read found. */
function found(name: string, out: Record<string, unknown>): string | null {
  switch (name) {
    case 'needs_attention': {
      const c = out.counts as { approvals: number; failed: number; stalled: number } | undefined;
      if (!c) return null;
      const total = c.approvals + c.failed + c.stalled;
      return total
        ? `${c.approvals} approvals · ${c.failed} failed · ${c.stalled} stalled`
        : 'Nothing waiting';
    }
    case 'find_orders':
      return `${out.count} found · ${out.total}`;
    case 'get_order':
      return `${out.ref} · ${String(out.status ?? '').replace('_', ' ')}`;
    case 'find_products':
      return `${n(out.products)} products`;
    case 'list_flows':
      return `${n(out.flows)} flows`;
    case 'get_flow':
      return typeof out.name === 'string' ? out.name : null;
    default:
      return null;
  }
}

/** A tool the assistant used to read, as one ruled row. */
export function ReadRow({ part }: { part: Part }) {
  const name = getToolName(part);
  const Icon = ICONS[name] ?? Search;
  const label = isAssistantTool(name) ? ASSISTANT_TOOLS[name].label : name;
  const running = part.state === 'input-streaming' || part.state === 'input-available';
  const failed = part.state === 'output-error';
  const out =
    part.state === 'output-available' ? ((part.output ?? {}) as Record<string, unknown>) : null;
  return (
    <div className="flex min-h-7 items-center gap-2 border-rule border-y border-dashed py-1 text-[12.5px] text-muted-foreground [&+&]:border-t-0">
      <Icon className="size-3.5 shrink-0" aria-hidden="true" />
      {running ? (
        <span className="flex items-center gap-1.5">
          {RUNNING[name] ?? label}
          <span aria-hidden="true" className="ol-dots" />
        </span>
      ) : (
        <span className="min-w-0 truncate">{label}</span>
      )}
      {out ? (
        <span className="ml-auto shrink-0 tabular text-foreground/80">{found(name, out)}</span>
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

export type Previewer = (tool: string, input: unknown) => Promise<ActionPreview>;

const DESTRUCTIVE = (name: string, input: Record<string, unknown>) =>
  name === 'cancel_order' || (name === 'decide_approval' && input.decision === 'rejected');

const VERB: Record<string, (input: Record<string, unknown>) => string> = {
  decide_approval: (i) => (i.decision === 'rejected' ? 'Reject' : 'Approve'),
  deliver_event: () => 'Deliver event',
  cancel_order: () => 'Cancel order',
  publish_flow: () => 'Publish',
  run_stock_review: () => 'Run review',
};

/**
 * An action the assistant prepared. Before anything is sent the card states what will happen,
 * resolved against live data; one press confirms it, and focus starts on the safe choice.
 */
export function ActionCard({
  part,
  preview,
  respond,
}: {
  part: Part;
  preview: Previewer;
  respond: (approvalId: string, approved: boolean) => void;
}) {
  const name = getToolName(part);
  const input = (part.input ?? {}) as Record<string, unknown>;
  const [p, setP] = useState<ActionPreview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const titleId = useId();
  const safe = useRef<HTMLButtonElement>(null);
  const asking = part.state === 'approval-requested';
  const inputKey = JSON.stringify(input);

  useEffect(() => {
    if (!asking) return;
    let live = true;
    preview(name, input)
      .then((r) => live && setP(r))
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [asking, name, inputKey, preview]);

  useEffect(() => {
    if (asking && p && !p.blocked) safe.current?.focus({ preventScroll: true });
  }, [asking, p]);

  const fallbackTitle = isAssistantTool(name) ? ASSISTANT_TOOLS[name].label : name;

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
  const verb = VERB[name]?.(input) ?? 'Confirm';
  const blocked = p?.blocked;
  return (
    <section
      aria-labelledby={titleId}
      className="ol-confirm my-1 rounded-md border border-input bg-card text-sm"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && approvalId && !sent) {
          e.stopPropagation();
          setSent(true);
          respond(approvalId, false);
        }
      }}
    >
      <header className="flex items-baseline gap-2 border-b px-3 py-2">
        <h3 id={titleId} className="min-w-0 flex-1 font-semibold leading-snug">
          {p?.title ?? fallbackTitle}
        </h3>
        {p?.href ? (
          <Link
            to={p.href}
            className="shrink-0 text-link text-xs hover:underline"
            aria-label={`Open ${p.title}`}
          >
            Open
          </Link>
        ) : null}
      </header>
      {p ? (
        p.consequences.length ? (
          <ul className="divide-y divide-dashed px-3 tabular">
            {p.consequences.map((c) => (
              <li key={c} className="py-1.5 text-[13px] leading-snug">
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
      <footer className="flex flex-wrap items-center gap-2 border-t bg-muted/40 px-3 py-2">
        {blocked ? (
          <p className="min-w-0 flex-1 text-[13px] text-wait leading-snug">{blocked}</p>
        ) : (
          <p className="min-w-0 flex-1 text-muted-foreground text-xs">
            Nothing is sent until you confirm.
          </p>
        )}
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
      </footer>
    </section>
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
    'flex items-start gap-2 border-y py-1.5 text-[13px] leading-snug',
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
    <section className="my-1 rounded-md border border-input bg-card text-sm">
      <header className="border-b px-3 py-2">
        <h3 className="font-semibold leading-snug">Proposed change to {pr.flowName}</h3>
      </header>
      <div className="space-y-1.5 px-3 py-2">
        <p className="text-[13px] leading-snug">{pr.explanation}</p>
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
      <footer className="flex items-center gap-2 border-t bg-muted/40 px-3 py-2">
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
      </footer>
    </section>
  );
}
