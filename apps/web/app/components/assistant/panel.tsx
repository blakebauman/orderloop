/**
 * The assistant panel: one conversation per person, docked on the right of every page. It talks to
 * the person's own AssistantAgent over the proxied socket (`useAgentChat`), so a reply keeps going
 * if the tab sleeps and picks up again when it wakes. The page in front supplies the context chip.
 */

import { useAgentChat } from '@cloudflare/ai-chat/react';
import {
  type ActionPreview,
  ASSISTANT_TOOLS,
  type Attention,
  atLeast,
  isAssistantTool,
  ROLE_LABELS,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@orderloop/ui/dropdown-menu';
import { cn } from '@orderloop/ui/lib/utils';
import { useAgent } from 'agents/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { ArrowUp, ChevronDown, Info, MoreHorizontal, Square, X } from 'lucide-react';
import { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { contextLabel, useAssistant } from '~/lib/assistant';
import { orderRef, plural } from '~/lib/format';
import { useMe } from '~/lib/use-me';
import { ActionCard, ProposalCard, Prose, ReadRow } from './parts';

/**
 * The docked panel. On wide screens it takes a column beside the page (the page narrows; nothing is
 * covered); below that it is a full-height sheet under the top bar. Mounted on first open only, so
 * nobody connects to an assistant they never opened.
 */
export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);
  return (
    <aside
      aria-label="Assistant"
      inert={!open}
      className={cn(
        'z-30 overflow-hidden bg-card motion-reduce:transition-none',
        // Phones and tablets: a sheet over the page, below the top bar.
        'fixed inset-x-0 top-12 bottom-0 transition-[opacity,translate] duration-200 ease-out',
        open ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        // Wide screens: a column beside the page. It opens without animating its width, which would
        // reflow the whole page (the graph canvas included) on every frame.
        'lg:sticky lg:inset-auto lg:top-12 lg:h-[calc(100dvh-3rem)] lg:shrink-0 lg:translate-y-0 lg:opacity-100 lg:transition-none',
        open ? 'lg:w-[400px] lg:border-l' : 'lg:w-0',
      )}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          if (!window.matchMedia('(min-width: 1024px)').matches) setOpen(false);
          document.getElementById('main')?.focus({ preventScroll: true });
        }
      }}
    >
      <div className="flex h-full flex-col lg:w-[400px]">
        {opened ? (
          <Suspense fallback={<PanelFrame busy />}>
            <Conversation />
          </Suspense>
        ) : null}
      </div>
    </aside>
  );
}

function PanelFrame({ busy }: { busy?: boolean }) {
  return (
    <div className="flex h-full flex-col">
      <PanelHeader />
      <div className="flex-1 px-4 py-6 text-muted-foreground text-sm">
        {busy ? (
          <>
            Opening your conversation
            <span aria-hidden="true" className="ol-dots" />
          </>
        ) : null}
      </div>
    </div>
  );
}

function PanelHeader({ onClear, canClear }: { onClear?: () => void; canClear?: boolean }) {
  const { setOpen, page, scope, setScope } = useAssistant();
  const onPage = page.kind !== 'workspace';
  const current = scope === 'workspace' || !onPage ? 'Everything' : contextLabel(page);
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <h2 className="font-semibold text-[15px] tracking-title">Assistant</h2>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex h-6 min-w-0 max-w-[60%] items-center gap-1 rounded-sm border border-input px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
          aria-label={`Asking about: ${current}`}
        >
          <span className="truncate">{current}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuLabel className="caption font-medium">Ask about</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={onPage ? scope : 'workspace'}
            onValueChange={(v) => setScope(v as 'page' | 'workspace')}
          >
            <DropdownMenuRadioItem value="page" disabled={!onPage}>
              <span className="truncate">
                {onPage
                  ? `${page.kind === 'order' ? 'This order' : 'This flow'}: ${contextLabel(page)}`
                  : 'This page (nothing open)'}
              </span>
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="workspace">Everything</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <div className="ml-auto flex items-center">
        {onClear ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Conversation options"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled={!canClear} onSelect={onClear}>
                Start a new conversation
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <a
                  href="https://docs.orderloop.app/guides/assistant/"
                  target="_blank"
                  rel="noreferrer"
                >
                  How the assistant works
                </a>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close the assistant (⌘J)"
          title="Close (⌘J)"
        >
          <X className="size-4" />
        </button>
      </div>
    </header>
  );
}

type Meta = { source?: 'model' | 'heuristic' };
type Message = UIMessage<Meta>;

function Conversation() {
  const me = useMe();
  const a = useAssistant();
  const readPage = useRef(a.readPage);
  readPage.current = a.readPage;

  const agent = useAgent({ agent: 'assistant-agent', name: me?.id ?? 'me' });
  const chat = useAgentChat<unknown, Message>({
    agent,
    body: () => ({ context: readPage.current() }),
  });
  const { messages, sendMessage, status, stop, addToolApprovalResponse, clearHistory } = chat;
  const busy = chat.isStreaming || chat.isRecovering || status === 'submitted';

  // ── Attention: always shown, refreshed while the panel is open and after each turn.
  const [attention, setAttention] = useState<Attention | null>(null);
  const [attentionError, setAttentionError] = useState(false);
  const refresh = useCallback(() => {
    agent
      .call('attention', [])
      .then((r) => {
        setAttention(r as Attention);
        setAttentionError(false);
      })
      .catch(() => setAttentionError(true));
  }, [agent]);
  useEffect(() => {
    if (!a.open) return;
    refresh();
    const t = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(t);
  }, [a.open, refresh]);
  const wasBusy = useRef(false);
  useEffect(() => {
    if (wasBusy.current && !busy) refresh();
    wasBusy.current = busy;
  }, [busy, refresh]);

  const preview = useCallback(
    (tool: string, input: unknown) =>
      agent.call('preview', [tool, input]) as Promise<ActionPreview>,
    [agent],
  );
  const respond = useCallback(
    (id: string, approved: boolean) => addToolApprovalResponse({ id, approved }),
    [addToolApprovalResponse],
  );

  // ── Messages written while a reply is running wait here, editable, until it ends.
  const [held, setHeld] = useState<string[]>([]);
  const send = useCallback(
    (text: string) => {
      const t = text.trim();
      if (!t) return;
      if (busy) setHeld((h) => [...h, t]);
      else void sendMessage({ text: t });
    },
    [busy, sendMessage],
  );
  useEffect(() => {
    if (busy || !held.length) return;
    const [next, ...rest] = held;
    setHeld(rest);
    void sendMessage({ text: next! });
  }, [busy, held, sendMessage]);

  // A question asked from a page ("Ask about this order").
  useEffect(() => {
    if (!a.pendingAsk) return;
    const t = a.takeAsk();
    if (t) send(t);
  }, [a.pendingAsk, a.takeAsk, send]);

  // ── Scroll: follow new content while the reader is at the bottom.
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const last = messages.at(-1);
  const lastLength = last ? JSON.stringify(last.parts).length : 0;
  useEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, lastLength, held.length]);

  const thinking =
    status === 'submitted' || (busy && last?.role === 'user') || (busy && last?.parts.length === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader onClear={clearHistory} canClear={messages.length > 0 && !busy} />
      <AttentionLine data={attention} failed={attentionError} />
      {chat.connectionError ? (
        <p className="border-b bg-wait/10 px-4 py-1.5 text-[12.5px] text-wait" role="status">
          Reconnecting to your assistant
          <span aria-hidden="true" className="ol-dots" />
        </p>
      ) : null}
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="ol-scroll min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        {messages.length === 0 ? (
          <FirstRun onAsk={send} />
        ) : (
          <ol className="space-y-5" aria-live="polite" aria-relevant="additions">
            {messages.map((m, i) => (
              <li key={m.id}>
                {m.role === 'user' ? (
                  <UserMessage m={m} />
                ) : (
                  <AssistantMessage
                    m={m}
                    streaming={busy && i === messages.length - 1}
                    preview={preview}
                    respond={respond}
                  />
                )}
              </li>
            ))}
          </ol>
        )}
        {thinking ? (
          <p
            className="mt-4 flex items-center gap-2 text-[13px] text-muted-foreground"
            role="status"
          >
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-ai motion-safe:animate-pulse"
            />
            {chat.isRecovering ? 'Picking up where it left off' : 'Working on it'}
          </p>
        ) : null}
      </div>
      {held.length ? (
        <HeldMessages
          held={held}
          onChange={(i, text) => setHeld((h) => h.map((x, j) => (j === i ? text : x)))}
          onRemove={(i) => setHeld((h) => h.filter((_, j) => j !== i))}
        />
      ) : null}
      <Composer busy={busy} onSend={send} onStop={() => stop()} />
    </div>
  );
}

function UserMessage({ m }: { m: Message }) {
  const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
  return (
    <div className="ml-auto w-fit max-w-[88%] whitespace-pre-wrap rounded-md bg-secondary px-3 py-2 text-[13.5px] leading-normal">
      {text}
    </div>
  );
}

const ACTION = new Set(
  Object.entries(ASSISTANT_TOOLS)
    .filter(([, t]) => t.confirm)
    .map(([name]) => name),
);

function AssistantMessage({
  m,
  streaming,
  preview,
  respond,
}: {
  m: Message;
  streaming: boolean;
  preview: (tool: string, input: unknown) => Promise<ActionPreview>;
  respond: (approvalId: string, approved: boolean) => void;
}) {
  const parts = m.parts;
  const lastText = parts.findLastIndex((p) => p.type === 'text');
  return (
    <div className="space-y-2">
      {parts.map((p, i) => {
        if (p.type === 'text')
          return p.text.trim() ? (
            <Prose key={i} text={p.text} streaming={streaming && i === lastText} />
          ) : null;
        if (isToolUIPart(p)) {
          const name = getToolName(p);
          if (ACTION.has(name))
            return <ActionCard key={p.toolCallId} part={p} preview={preview} respond={respond} />;
          if (name === 'propose_flow_change') return <ProposalCard key={p.toolCallId} part={p} />;
          if (isAssistantTool(name)) return <ReadRow key={p.toolCallId} part={p} />;
        }
        return null;
      })}
      {m.metadata?.source === 'heuristic' && !streaming ? (
        <p className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Info className="size-3" aria-hidden="true" />
          Answered without the language model, from fixed rules.
        </p>
      ) : null}
    </div>
  );
}

// ── What is waiting on people ──────────────────────────────────────────────

/** Always on screen, and says so when nothing is waiting: a line that only appears in trouble
 * teaches people not to look at it. */
function AttentionLine({ data, failed }: { data: Attention | null; failed: boolean }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  if (!data)
    return (
      <p className="border-b px-4 py-2 text-[12.5px] text-muted-foreground">
        {failed ? 'Couldn’t check what is waiting.' : 'Checking what is waiting'}
        {failed ? null : <span aria-hidden="true" className="ol-dots" />}
      </p>
    );
  const { approvals, failed: failedN, stalled } = data.counts;
  const total = approvals + failedN + stalled;
  if (!total)
    return (
      <p className="flex items-center gap-2 border-b px-4 py-2 text-[12.5px] text-muted-foreground">
        <span aria-hidden="true" className="size-1.5 rounded-full bg-idle" />
        Nothing is waiting on anyone
      </p>
    );
  return (
    <div className="border-b">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left text-[12.5px] tabular hover:bg-muted/50"
      >
        <span className="font-medium text-foreground">Needs attention</span>
        {approvals ? <span className="text-wait">{plural(approvals, 'approval')}</span> : null}
        {/* The same words as the overview: these counts cover failed and rolled-back orders, and
            orders waiting on an outside event. */}
        {failedN ? <span className="text-bad">{failedN} failed or rolled back</span> : null}
        {stalled ? (
          <span className="text-muted-foreground">{stalled} waiting on events</span>
        ) : null}
        <ChevronDown
          className={cn(
            'ml-auto size-3.5 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul
          id={listId}
          className="max-h-56 divide-y divide-dashed overflow-y-auto border-t px-4 text-[12.5px]"
        >
          {data.approvals.map((x) => (
            <AttentionItem
              key={x.id}
              to={`/orders/${x.orderId}`}
              tone="wait"
              what={x.title}
              id={x.orderId}
            />
          ))}
          {data.failed.map((x) => (
            <AttentionItem
              key={x.id}
              to={`/orders/${x.id}`}
              tone="bad"
              what={`${x.title || 'Order'} ${x.status.replace('_', ' ')}`}
              id={x.id}
            />
          ))}
          {data.stalled.map((x) => (
            <AttentionItem
              key={x.id}
              to={`/orders/${x.id}`}
              tone="idle"
              what={x.waitingOn ?? 'Waiting on an event'}
              id={x.id}
            />
          ))}
          {approvals > data.approvals.length ? (
            <li className="py-1.5">
              <Link to="/approvals" className="text-link hover:underline">
                All {approvals} approvals
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function AttentionItem({
  to,
  tone,
  what,
  id,
}: {
  to: string;
  tone: 'wait' | 'bad' | 'idle';
  what: string;
  id: string;
}) {
  return (
    <li>
      <Link to={to} className="flex items-center gap-2 py-1.5 hover:underline">
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            tone === 'wait' ? 'bg-wait' : tone === 'bad' ? 'bg-bad' : 'bg-idle',
          )}
        />
        <span className="min-w-0 flex-1 truncate">{what}</span>
        <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
          {orderRef(id)}
        </span>
      </Link>
    </li>
  );
}

// ── First run ──────────────────────────────────────────────────────────────

function FirstRun({ onAsk }: { onAsk: (text: string) => void }) {
  const { page, scope } = useAssistant();
  const me = useMe();
  const operator = atLeast(me?.role, 'operator');
  const ctx = scope === 'workspace' ? 'workspace' : page.kind;
  const ideas =
    ctx === 'order'
      ? [
          'Why is this order where it is?',
          ...(page.kind === 'order' && page.awaitingApproval
            ? ['What happens if it’s approved?']
            : []),
          'Summarize its activity',
        ]
      : ctx === 'flow'
        ? [
            'Explain this flow step by step',
            ...(operator ? ['Add a risk score after the credit check'] : []),
            'What could make an order stall here?',
          ]
        : ['What needs me?', 'Waiting orders over $10k this week', 'Which SKUs are low on stock?'];
  return (
    <div className="space-y-4">
      <div className="space-y-1.5 text-[13.5px] leading-relaxed">
        <p>Ask about orders, approvals, stock and flows.</p>
        <p className="text-muted-foreground">
          It works within your role{me ? ` (${ROLE_LABELS[me.role].toLowerCase()})` : ''} and asks
          you before anything that can’t be undone: decisions, cancellations, events and publishing.
        </p>
      </div>
      <ul className="space-y-1.5">
        {ideas.map((t) => (
          <li key={t}>
            <button
              type="button"
              onClick={() => onAsk(t)}
              className="w-full rounded-md border border-input px-3 py-1.5 text-left text-[13px] hover:bg-muted/60"
            >
              {t}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── Composer ───────────────────────────────────────────────────────────────

function HeldMessages({
  held,
  onChange,
  onRemove,
}: {
  held: string[];
  onChange: (i: number, text: string) => void;
  onRemove: (i: number) => void;
}) {
  return (
    <div className="border-t bg-muted/40 px-3 py-2">
      <p className="caption mb-1">Sends when this reply finishes</p>
      <ul className="space-y-1">
        {held.map((t, i) => (
          <li key={i} className="flex items-center gap-1.5">
            <input
              value={t}
              onChange={(e) => onChange(i, e.target.value)}
              aria-label="Queued message"
              className="h-7 min-w-0 flex-1 rounded-sm border border-input bg-card px-2 text-[13px]"
            />
            <button
              type="button"
              onClick={() => onRemove(i)}
              className="grid size-6 place-items-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Remove queued message"
            >
              <X className="size-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Composer({
  busy,
  onSend,
  onStop,
}: {
  busy: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const { focusToken } = useAssistant();
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusToken) box.current?.focus();
  }, [focusToken]);
  const submit = () => {
    if (!text.trim()) return;
    onSend(text);
    setText('');
  };
  return (
    <form
      className="shrink-0 border-t p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-2 rounded-md border border-input bg-background px-2.5 py-2 focus-within:border-link">
        <textarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          placeholder={
            busy ? 'Write the next message; it sends when this reply ends' : 'Ask the assistant'
          }
          aria-label="Message the assistant"
          className="max-h-40 min-h-6 flex-1 resize-none bg-transparent text-[13.5px] leading-6 outline-none [field-sizing:content] placeholder:text-muted-foreground"
        />
        {busy ? (
          <Button
            type="button"
            size="icon-xs"
            variant="outline"
            onClick={onStop}
            aria-label="Stop the reply"
            title="Stop"
          >
            <Square className="fill-current" />
          </Button>
        ) : null}
        <Button
          type="submit"
          size="icon-xs"
          disabled={!text.trim()}
          aria-label="Send"
          title="Send (Enter)"
        >
          <ArrowUp />
        </Button>
      </div>
      <p className="mt-1.5 text-muted-foreground text-xs">
        Enter sends · Shift+Enter for a new line · ⌘J opens and closes
      </p>
    </form>
  );
}
