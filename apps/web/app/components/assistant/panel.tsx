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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@orderloop/ui/alert-dialog';
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
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Info,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  ConversationContent,
  Conversation as ConversationLog,
  ConversationScrollButton,
} from '~/components/ai-elements/conversation';
import {
  MessageAction,
  MessageActions,
  MessageContent,
  Message as MessageFrame,
} from '~/components/ai-elements/message';
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '~/components/ai-elements/prompt-input';
import {
  Queue,
  QueueItem,
  QueueItemAction,
  QueueItemActions,
  QueueList,
} from '~/components/ai-elements/queue';
import { Shimmer } from '~/components/ai-elements/shimmer';
import { Suggestion, Suggestions } from '~/components/ai-elements/suggestion';
import { contextLabel, useAssistant } from '~/lib/assistant';
import { coarse, useMedia, useVisualViewport, WIDE } from '~/lib/device';
import { orderRef, plural } from '~/lib/format';
import { useMe } from '~/lib/use-me';
import { ActionCard, PluginDraftCard, type Previewer, ProposalCard, Prose, ReadRow } from './parts';

/**
 * The docked panel. On wide screens it takes a column beside the page (the page narrows; nothing is
 * covered); below that it is a full-height sheet under the top bar. Mounted on first open only, so
 * nobody connects to an assistant they never opened.
 */
export function AssistantPanel() {
  const { open, setOpen } = useAssistant();
  const [opened, setOpened] = useState(false);
  // As a sheet, it keeps its composer above the on-screen keyboard.
  const wide = useMedia(WIDE);
  useVisualViewport(open && !wide);
  useEffect(() => {
    if (open) setOpened(true);
  }, [open]);
  return (
    <aside
      aria-label="Assistant"
      inert={!open}
      className={cn(
        'z-30 overflow-hidden bg-card motion-reduce:transition-none',
        // Phones and tablets: a sheet over the page, between the top bar and the phone tab bar.
        'fixed inset-x-0 top-[var(--shell-h)] bottom-[var(--tabbar-h)] transition-[opacity,translate] duration-200 ease-out',
        open ? 'opacity-100' : 'pointer-events-none translate-y-2 opacity-0',
        // With the keyboard up, it takes exactly the visible area above it, over the bars.
        'in-data-keyboard:z-50 in-data-keyboard:top-[var(--vvtop)] in-data-keyboard:bottom-auto in-data-keyboard:h-[var(--vvh)]',
        // Wide screens: a column beside the page. It opens without animating its width, which would
        // reflow the whole page (the graph canvas included) on every frame.
        'lg:sticky lg:inset-auto lg:top-[var(--shell-h)] lg:h-[calc(100dvh-var(--shell-h))] lg:shrink-0 lg:translate-y-0 lg:opacity-100 lg:transition-none',
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
        {busy ? <Shimmer>Opening your conversation</Shimmer> : null}
      </div>
    </div>
  );
}

function PanelHeader({ onClear, canClear }: { onClear?: () => void; canClear?: boolean }) {
  const { setOpen, page, scope, setScope } = useAssistant();
  const onPage = page.kind !== 'workspace';
  const current = scope === 'workspace' || !onPage ? 'Everything' : contextLabel(page);
  const [clearing, setClearing] = useState(false);
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <h2 className="font-semibold text-[15px] tracking-title">Assistant</h2>
      <DropdownMenu>
        <DropdownMenuTrigger
          className="hit-area flex h-6 min-w-0 max-w-[60%] items-center gap-1 rounded-sm border border-input px-1.5 text-[12px] text-muted-foreground hover:text-foreground"
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
              className="hit-area grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Conversation options"
            >
              <MoreHorizontal className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem disabled={!canClear} onSelect={() => setClearing(true)}>
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
          className="hit-area grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Close the assistant (⌘J)"
          title="Close (⌘J)"
        >
          <X className="size-4" />
        </button>
        {onClear ? (
          <AlertDialog open={clearing} onOpenChange={setClearing}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Start a new conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  This conversation is deleted; it was only yours. Actions you confirmed stay done
                  and stay in the audit log.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={onClear}>
                  Start over
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
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
  const {
    messages,
    sendMessage,
    regenerate,
    status,
    stop,
    error,
    clearError,
    addToolApprovalResponse,
    clearHistory,
  } = chat;
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
    (tool: string, input: unknown, callId: string) =>
      agent.call('preview', [tool, input, callId]) as Promise<ActionPreview>,
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

  const last = messages.at(-1);
  const lastAssistant = messages.findLastIndex((m) => m.role === 'assistant');
  // Editing or answering again rewrites what came after; never across a prepared action, which
  // may already have happened.
  const lastAction = messages.findLastIndex(hasAction);
  // Editing a sent message replaces it, and drops what came after, with the new text.
  const edit = useCallback(
    (messageId: string, text: string) => {
      const t = text.trim();
      if (t && !busy) void sendMessage({ text: t, messageId });
    },
    [busy, sendMessage],
  );

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
      <ConversationLog className="ol-scroll min-h-0">
        <ConversationContent>
          {messages.length === 0 ? (
            <FirstRun onAsk={send} />
          ) : (
            <ol className="space-y-3" aria-live="polite" aria-relevant="additions">
              {messages.map((m, i) => (
                <li key={m.id}>
                  {m.role === 'user' ? (
                    <UserMessage m={m} busy={busy} onEdit={i > lastAction ? edit : undefined} />
                  ) : (
                    <AssistantMessage
                      m={m}
                      streaming={busy && i === messages.length - 1}
                      preview={preview}
                      respond={respond}
                      // Only the latest reply can be asked again, and not while one is running.
                      onRegenerate={
                        i === lastAssistant &&
                        i === messages.length - 1 &&
                        i !== lastAction &&
                        !busy
                          ? () => void regenerate()
                          : undefined
                      }
                    />
                  )}
                </li>
              ))}
            </ol>
          )}
          {thinking ? (
            <div role="status" className="flex items-center gap-2 text-[13px]">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-ai" />
              <Shimmer as="span">
                {chat.isRecovering ? 'Picking up where it left off' : 'Working on it'}
              </Shimmer>
            </div>
          ) : null}
          {error && !busy ? (
            <TurnError
              message={error.message}
              onRetry={() => {
                clearError();
                void regenerate();
              }}
              onDismiss={clearError}
            />
          ) : null}
        </ConversationContent>
        <ConversationScrollButton />
      </ConversationLog>
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

const textOf = (m: Message) =>
  m.parts
    .map((p) => (p.type === 'text' ? p.text : ''))
    .join('')
    .trim();

/** Copies the text, then says so for a moment. */
function CopyAction({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = window.setTimeout(() => setDone(false), 1500);
    return () => window.clearTimeout(t);
  }, [done]);
  return (
    <MessageAction
      label={done ? 'Copied' : 'Copy'}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? <Check /> : <Copy />}
    </MessageAction>
  );
}

function UserMessage({
  m,
  busy,
  onEdit,
}: {
  m: Message;
  busy: boolean;
  onEdit?: (messageId: string, text: string) => void;
}) {
  const text = textOf(m);
  const [draft, setDraft] = useState<string | null>(null);
  if (draft !== null) {
    const changed = draft.trim() && draft.trim() !== text;
    return (
      <MessageFrame from="user" className="max-w-full">
        <PromptInput
          aria-label="Edit your message"
          onSubmit={() => {
            if (!changed) return;
            onEdit?.(m.id, draft);
            setDraft(null);
          }}
        >
          <PromptInputTextarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                setDraft(null);
              }
            }}
            sendOnEnter={(e) => !coarse() || e.metaKey || e.ctrlKey}
            aria-label="Edited message"
          />
          <PromptInputFooter className="justify-end">
            <Button type="button" size="xs" variant="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Button>
            <Button type="submit" size="xs" disabled={!changed || busy}>
              Send again
            </Button>
          </PromptInputFooter>
        </PromptInput>
        <p className="text-muted-foreground text-xs">
          Sending again replaces this message and the replies after it.
        </p>
      </MessageFrame>
    );
  }
  // The actions sit beside the bubble, so a question costs no extra line.
  return (
    <MessageFrame from="user" className="flex-row-reverse items-center gap-1">
      <MessageContent>{text}</MessageContent>
      <MessageActions>
        <CopyAction text={text} />
        {onEdit ? (
          <MessageAction label="Edit" disabled={busy} onClick={() => setDraft(text)}>
            <Pencil />
          </MessageAction>
        ) : null}
      </MessageActions>
    </MessageFrame>
  );
}

const ACTION = new Set(
  Object.entries(ASSISTANT_TOOLS)
    .filter(([, t]) => t.confirm)
    .map(([name]) => name),
);

/** Whether a message prepared an action (a tool that waits for a person to confirm it). */
const hasAction = (m: Message) =>
  m.parts.some((p) => isToolUIPart(p) && ACTION.has(getToolName(p)));

function AssistantMessage({
  m,
  streaming,
  preview,
  respond,
  onRegenerate,
}: {
  m: Message;
  streaming: boolean;
  preview: Previewer;
  respond: (approvalId: string, approved: boolean) => void;
  onRegenerate?: () => void;
}) {
  const parts = m.parts;
  const lastText = parts.findLastIndex((p) => p.type === 'text');
  const text = textOf(m);
  return (
    <MessageFrame from="assistant">
      <MessageContent className="space-y-2">
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
            if (name === 'draft_plugin') return <PluginDraftCard key={p.toolCallId} part={p} />;
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
      </MessageContent>
      {!streaming && (text || onRegenerate) ? (
        <MessageActions>
          {text ? <CopyAction text={text} /> : null}
          {onRegenerate ? (
            <MessageAction label="Answer again" onClick={onRegenerate}>
              <RotateCcw />
            </MessageAction>
          ) : null}
        </MessageActions>
      ) : null}
    </MessageFrame>
  );
}

/** A turn that failed: what went wrong, in a sentence, with the way to try again. */
function TurnError({
  message,
  onRetry,
  onDismiss,
}: {
  message: string;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-2xl bg-bad/10 px-3 py-2 text-sm">
      <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-bad">The assistant couldn’t finish that reply.</p>
        <p className="break-words text-muted-foreground text-xs">{message}</p>
      </div>
      <Button size="xs" variant="outline" onClick={onRetry}>
        Try again
      </Button>
      <button
        type="button"
        onClick={onDismiss}
        className="hit-area grid size-6 place-items-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Dismiss"
      >
        <X className="size-3.5" />
      </button>
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
        {/* The overview's words, with the window: the overview counts every such order, this line
            only the last 3 days (`attention` in the engine), so it says so. */}
        {failedN ? (
          <span className="text-bad">{failedN} failed or rolled back in 3 days</span>
        ) : null}
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
      <Suggestions>
        {ideas.map((t) => (
          <Suggestion key={t} suggestion={t} onClick={onAsk} />
        ))}
      </Suggestions>
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
    <Queue className="mx-3 mt-2">
      <p className="caption px-1">Sends when this reply finishes</p>
      <QueueList>
        {held.map((t, i) => (
          <QueueItem key={i}>
            <input
              value={t}
              onChange={(e) => onChange(i, e.target.value)}
              aria-label="Queued message"
              className="h-7 min-w-0 flex-1 rounded-xl bg-transparent px-2 text-[13px] focus-visible:bg-background focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
            />
            <QueueItemActions>
              <QueueItemAction label="Remove queued message" onClick={() => onRemove(i)}>
                <X className="size-3.5" />
              </QueueItemAction>
            </QueueItemActions>
          </QueueItem>
        ))}
      </QueueList>
    </Queue>
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
  return (
    <div className="shrink-0 p-3 in-data-keyboard:pb-2">
      <PromptInput
        onSubmit={() => {
          if (!text.trim()) return;
          onSend(text);
          setText('');
        }}
      >
        <PromptInputTextarea
          ref={box}
          value={text}
          onChange={(e) => setText(e.target.value)}
          // On a touch screen Return is a new line and the button sends; ⌘/Ctrl+Enter always sends.
          sendOnEnter={(e) => !coarse() || e.metaKey || e.ctrlKey}
          placeholder={
            busy ? 'Write the next message; it sends when this reply ends' : 'Ask the assistant'
          }
          aria-label="Message the assistant"
        />
        <PromptInputFooter className="justify-end gap-1.5 pt-0">
          {/* While a reply runs, stop sits beside send, which queues the next message. */}
          {busy ? (
            <PromptInputSubmit status="streaming" onStop={onStop} className="touch:size-9" />
          ) : null}
          <PromptInputSubmit disabled={!text.trim()} className="touch:size-9" />
        </PromptInputFooter>
      </PromptInput>
      <p className="mt-1.5 hidden px-1 text-muted-foreground text-xs fine:block">
        Enter sends · Shift+Enter for a new line · ⌘J opens and closes
      </p>
    </div>
  );
}
