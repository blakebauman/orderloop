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
import { Item, ItemContent, ItemMedia, ItemTitle } from '@orderloop/ui/item';
import { cn } from '@orderloop/ui/lib/utils';
import { useAgent } from 'agents/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import {
  Check,
  ChevronDown,
  CircleAlert,
  Copy,
  Info,
  MessageSquareText,
  MoreHorizontal,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react';
import { Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  MessageAction,
  MessageActions,
  MessageContent,
  Message as MessageFrame,
} from '~/components/ai-elements/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '~/components/ai-elements/message-scroller';
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
import { Trace } from '~/components/ai-elements/trace';
import { Empty } from '~/components/page';
import { contextLabel, useAssistant } from '~/lib/assistant';
import { coarse, useMedia, useShortcutLabel, useVisualViewport, WIDE } from '~/lib/device';
import { orderRef, plural } from '~/lib/format';
import { useMe } from '~/lib/use-me';
import {
  ActionCard,
  actionVerb,
  PluginDraftCard,
  type Previewer,
  ProposalCard,
  Prose,
  ReadLine,
  ReasoningLine,
  SourcesLine,
  sourcesOf,
  statusWords,
} from './parts';

/**
 * The docked panel. On wide screens it takes a column beside the page (the page narrows; nothing is
 * covered); below that it is a full-height sheet under the top bar. Mounted on first open only, so
 * nobody connects to an assistant they never opened.
 *
 * Both slide, in 200ms with an exponential ease-out: the answer to a press starts fast and settles.
 * The sheet slides in from the right edge, where the button that opens it sits. The column moves
 * only by transform: opening takes its 400px at once (the page lays out one time) and slides its
 * content in from the right edge; closing slides the content out and gives the width back once it
 * has gone. Animating the width instead would lay the whole page out again on every frame.
 * Reduced motion shows and hides both at once.
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
        'z-30 overflow-hidden bg-card ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:transition-none',
        // Phones and tablets: a sheet over the page, between the top bar and the phone tab bar.
        'fixed inset-x-0 top-[var(--shell-h)] bottom-[var(--tabbar-h)] transition-[opacity,translate] duration-200 md:left-(--sidebar-width-icon)',
        open ? 'opacity-100' : 'pointer-events-none translate-x-full opacity-0',
        // With the keyboard up, it takes exactly the visible area above it, over the bars.
        'in-data-keyboard:z-50 in-data-keyboard:top-[var(--vvtop)] in-data-keyboard:bottom-auto in-data-keyboard:h-[var(--vvh)]',
        // Wide screens: a column beside the page. Its width changes in one step, not per frame: at
        // once on opening, and on closing only after the content's 200ms slide out.
        'lg:sticky lg:inset-auto lg:top-[var(--shell-h)] lg:flex lg:h-[calc(100dvh-var(--shell-h))] lg:shrink-0 lg:justify-end lg:translate-x-0 lg:opacity-100 lg:transition-[width] lg:duration-0 lg:motion-reduce:transition-none',
        open ? 'lg:w-[400px]' : 'lg:w-0 lg:delay-200',
      )}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && !e.defaultPrevented) {
          if (!window.matchMedia('(min-width: 1024px)').matches) setOpen(false);
          document.getElementById('main')?.focus({ preventScroll: true });
        }
      }}
    >
      <div
        className={cn(
          'flex h-full flex-col lg:w-[400px] lg:shrink-0 lg:border-l',
          'lg:transition-[opacity,translate] lg:duration-200 lg:ease-[cubic-bezier(0.16,1,0.3,1)] lg:motion-reduce:transition-none',
          open ? 'lg:translate-x-0 lg:opacity-100' : 'lg:translate-x-full lg:opacity-0',
        )}
      >
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

/**
 * What the next question is about. It sits in the composer, beside where the question is written
 * (and in thumb reach on a phone), not in the header.
 */
function ScopeChip() {
  const { page, scope, setScope } = useAssistant();
  const onPage = page.kind !== 'workspace';
  const current = scope === 'workspace' || !onPage ? 'Everything' : contextLabel(page);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="hit-area flex h-7 min-w-0 max-w-[70%] items-center gap-1 rounded-full border border-input px-2.5 text-[12px] text-muted-foreground hover:text-foreground touch:h-9 touch:px-3"
        aria-label={`Asking about: ${current}`}
      >
        <span className="truncate">{current}</span>
        <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-60">
        <DropdownMenuLabel className="caption">Ask about</DropdownMenuLabel>
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
  );
}

function PanelHeader({ onClear, canClear }: { onClear?: () => void; canClear?: boolean }) {
  const { setOpen } = useAssistant();
  const shortcut = useShortcutLabel('J');
  const [clearing, setClearing] = useState(false);
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
      <h2 className="font-semibold text-[15px] tracking-title">Assistant</h2>
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
                New conversation
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
          aria-label={`Close the assistant (${shortcut})`}
          title={`Close (${shortcut})`}
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
                  New conversation
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

  const { pending, replaced } = waitingActions(messages);
  const announcement = useAnnouncement(messages, busy, pending);

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
      {/* Not live: streamed text would be read out a fragment at a time. A finished reply, and an
          action that needs an answer, are announced once each instead (`useAnnouncement`). Each
          question anchors its turn: it rises near the top while the reply streams in below, and a
          saved thread opens on the last one. */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
        <MessageScroller className="min-h-0 flex-1">
          <MessageScrollerViewport aria-label="Conversation">
            <MessageScrollerContent aria-live="off" className="gap-3">
              {messages.length === 0 ? (
                <FirstRun onAsk={send} />
              ) : (
                // Items are the content's own children: the scroller finds each turn's anchor there.
                messages.map((m, i) => (
                  <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.role === 'user'}>
                    {m.role === 'user' ? (
                      <UserMessage m={m} busy={busy} onEdit={i > lastAction ? edit : undefined} />
                    ) : (
                      <AssistantMessage
                        m={m}
                        streaming={busy && i === messages.length - 1}
                        preview={preview}
                        respond={respond}
                        replaced={replaced}
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
                  </MessageScrollerItem>
                ))
              )}
              {thinking ? (
                <div role="status" className="flex items-center gap-2 text-ui">
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
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <p className="sr-only" role="status">
        {announcement}
      </p>
      {pending.length ? <WaitingBar pending={pending} /> : null}
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

type Waiting = { key: string; name: string; input: unknown };

/**
 * Names one action part in the conversation. Not its tool call id: a model may number its calls
 * afresh each turn, so the same id can turn up in several messages.
 */
const actionKey = (messageId: string, index: number) => `${messageId}:${index}`;

/**
 * The actions waiting for the person's answer, oldest first. The conversation is one per person and
 * live on every device they use, so the same action can be prepared twice (asked again here, or on
 * the phone). Only the newest of identical requests asks; the older ones are `replaced`.
 */
function waitingActions(messages: Message[]) {
  const asking: Waiting[] = [];
  for (const m of messages)
    m.parts.forEach((p, i) => {
      if (isToolUIPart(p) && p.state === 'approval-requested' && ACTION.has(getToolName(p)))
        asking.push({ key: actionKey(m.id, i), name: getToolName(p), input: p.input });
    });
  const newest = new Map<string, string>();
  for (const w of asking) newest.set(`${w.name} ${JSON.stringify(w.input)}`, w.key);
  const live = new Set(newest.values());
  return {
    pending: asking.filter((w) => live.has(w.key)),
    replaced: new Set(
      asking.filter((w) => !live.has(w.key)).map((w) => w.key),
    ) as ReadonlySet<string>,
  };
}

const actionLabel = (w: Waiting) => {
  const verb = actionVerb(w.name, w.input);
  return verb === 'Confirm' && isAssistantTool(w.name) ? ASSISTANT_TOOLS[w.name].label : verb;
};

/**
 * What a screen reader hears: a reply once it has finished (not each streamed fragment), and an
 * action once it starts waiting for an answer.
 */
function useAnnouncement(messages: Message[], busy: boolean, pending: Waiting[]) {
  const [said, setSaid] = useState('');
  const wasBusy = useRef(busy);
  const known = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (wasBusy.current && !busy) {
      const last = messages.at(-1);
      const text = last?.role === 'assistant' ? textOf(last) : '';
      if (text) setSaid(text.length > 300 ? `${text.slice(0, 300)}…` : text);
    }
    wasBusy.current = busy;
  }, [busy, messages]);
  useEffect(() => {
    // The first render only learns what is already waiting; it announces nothing.
    const ids = new Set(pending.map((w) => w.key));
    const fresh = known.current ? pending.filter((w) => !known.current!.has(w.key)) : [];
    known.current = ids;
    if (fresh.length) setSaid(`Waiting for your answer: ${fresh.map(actionLabel).join(', ')}`);
  }, [pending]);
  return said;
}

/**
 * Pinned above the composer while an action waits for the person, so it can't scroll out of mind
 * under newer turns. The conversation goes on; pressing it brings the card back, focused on the safe
 * choice.
 */
function WaitingBar({ pending }: { pending: Waiting[] }) {
  const newest = pending.at(-1)!;
  const show = () => {
    const card = document.querySelector<HTMLElement>(`[data-action="${CSS.escape(newest.key)}"]`);
    if (!card) return;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.scrollIntoView({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
    card.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  };
  return (
    <button
      type="button"
      onClick={show}
      className="mx-3 mt-2 flex min-h-9 items-center gap-2 rounded-full border border-wait/30 bg-wait/10 px-3 text-left text-[12.5px] hover:bg-wait/15"
    >
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-wait" />
      <span className="min-w-0 flex-1 truncate">
        {pending.length === 1 ? (
          <>
            <span className="font-medium text-foreground">Waiting for you:</span>{' '}
            <span className="text-muted-foreground">{actionLabel(newest)}</span>
          </>
        ) : (
          <span className="font-medium text-foreground">
            {pending.length} actions waiting for you
          </span>
        )}
      </span>
      <span className="shrink-0 font-medium text-foreground">Show</span>
    </button>
  );
}

type Indexed = { p: Message['parts'][number]; i: number };
type Segment = { at: number } & (
  | { trace: Indexed[]; part?: never }
  | { part: Indexed; trace?: never }
);

/**
 * A part that reads as one Trace line: a read, or an action no longer asking (answered, or
 * `replaced` by a newer request). An action that asks keeps its card outside the trace; proposals
 * and drafts have cards of their own.
 */
const isLine = (p: Message['parts'][number], replaced: boolean) => {
  if (!isToolUIPart(p)) return false;
  const name = getToolName(p);
  if (ACTION.has(name)) return replaced || p.state !== 'approval-requested';
  return isAssistantTool(name) && name !== 'propose_flow_change' && name !== 'draft_plugin';
};

/**
 * A message's parts in order, with each run of thinking and Trace lines gathered into one segment.
 * `replaced` says whether the action at a part's index was replaced by a newer request.
 */
export function segments(
  parts: Message['parts'],
  replaced: (i: number) => boolean = () => false,
): Segment[] {
  const out: Segment[] = [];
  parts.forEach((p, i) => {
    if (p.type === 'reasoning' || isLine(p, replaced(i))) {
      const last = out.at(-1);
      if (last?.trace) last.trace.push({ p, i });
      else out.push({ at: i, trace: [{ p, i }] });
    } else if (p.type !== 'step-start' && !(p.type === 'text' && !p.text.trim()))
      out.push({ at: i, part: { p, i } });
  });
  return out;
}

function AssistantMessage({
  m,
  streaming,
  preview,
  respond,
  replaced,
  onRegenerate,
}: {
  m: Message;
  streaming: boolean;
  preview: Previewer;
  respond: (approvalId: string, approved: boolean) => void;
  replaced: ReadonlySet<string>;
  onRegenerate?: () => void;
}) {
  const parts = m.parts;
  const lastText = parts.findLastIndex((p) => p.type === 'text');
  const text = textOf(m);
  // One record is already linked from its read's line; a list of them earns its own line.
  const sources = sourcesOf(parts);
  return (
    <MessageFrame from="assistant">
      <MessageContent className="space-y-2">
        {segments(parts, (i) => replaced.has(actionKey(m.id, i))).map((seg) => {
          // Thinking, reads and answered actions that run together share one Trace.
          if (seg.trace)
            return (
              <Trace key={seg.at}>
                {seg.trace.map(({ p, i }) =>
                  p.type === 'reasoning' ? (
                    <ReasoningLine
                      key={i}
                      text={p.text}
                      running={streaming && p.state === 'streaming'}
                    />
                  ) : isToolUIPart(p) && ACTION.has(getToolName(p)) ? (
                    <ActionCard
                      key={actionKey(m.id, i)}
                      part={p}
                      preview={preview}
                      respond={respond}
                      actionKey={actionKey(m.id, i)}
                      replaced={replaced.has(actionKey(m.id, i))}
                    />
                  ) : isToolUIPart(p) ? (
                    <ReadLine key={p.toolCallId} part={p} streaming={streaming} />
                  ) : null,
                )}
              </Trace>
            );
          const { p, i } = seg.part;
          if (p.type === 'text')
            return p.text.trim() ? (
              <Prose key={i} text={p.text} streaming={streaming && i === lastText} />
            ) : null;
          if (isToolUIPart(p)) {
            const name = getToolName(p);
            if (ACTION.has(name))
              return (
                <ActionCard
                  key={actionKey(m.id, i)}
                  part={p}
                  preview={preview}
                  respond={respond}
                  actionKey={actionKey(m.id, i)}
                  replaced={replaced.has(actionKey(m.id, i))}
                />
              );
            if (name === 'propose_flow_change')
              return <ProposalCard key={p.toolCallId} part={p} streaming={streaming} />;
            if (name === 'draft_plugin')
              return <PluginDraftCard key={p.toolCallId} part={p} streaming={streaming} />;
          }
          return null;
        })}
        {!streaming && sources.length > 1 ? (
          <Trace>
            <SourcesLine sources={sources} />
          </Trace>
        ) : null}
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
    <div role="alert" className="flex items-start gap-2 rounded-xl bg-bad/10 px-3 py-2 text-sm">
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
          <span className="text-bad">{failedN} failed or rolled back, last 3 days</span>
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
        <ul id={listId} className="flex max-h-56 flex-col overflow-y-auto border-t px-2 py-1">
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
              what={
                x.title ? `${x.title} ${statusWords(x.status)}` : capital(statusWords(x.status))
              }
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
            <Item asChild size="xs" className="relative px-2 py-1.5 touch:min-h-11">
              <li>
                <ItemContent>
                  <ItemTitle className="font-normal text-[12.5px]">
                    <Link to="/approvals" className={`text-link ${STRETCH}`}>
                      All {approvals} approvals
                    </Link>
                  </ItemTitle>
                </ItemContent>
              </li>
            </Item>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/** A row's link, stretched over the whole row so the row opens it. */
const STRETCH =
  'after:absolute after:inset-0 after:rounded-2xl hover:underline focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-[var(--ring)]';

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

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
    <Item
      asChild
      size="xs"
      className="relative flex-nowrap px-2 py-1.5 hover:bg-muted/60 touch:min-h-11"
    >
      <li>
        <ItemMedia>
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              tone === 'wait' ? 'bg-wait' : tone === 'bad' ? 'bg-bad' : 'bg-idle',
            )}
          />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full font-normal text-[12.5px]">
            {/* The ref stays inside the link: it is part of the row's name. */}
            <Link to={to} className={`flex w-full min-w-0 items-center gap-2 ${STRETCH}`}>
              <span className="min-w-0 flex-1 truncate">{what}</span>
              <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
                {orderRef(id)}
              </span>
            </Link>
          </ItemTitle>
        </ItemContent>
      </li>
    </Item>
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
        : [
            'What needs me?',
            'The largest waiting orders this week',
            'Which SKUs are low on stock?',
          ];
  return (
    <Empty
      className="px-0 py-6"
      icon={<MessageSquareText aria-hidden="true" />}
      title="Ask about orders, approvals, stock and flows."
      action={
        <Suggestions className="items-center">
          {ideas.map((t) => (
            <Suggestion key={t} suggestion={t} onClick={onAsk} />
          ))}
        </Suggestions>
      }
    >
      It works within your role{me ? ` (${ROLE_LABELS[me.role].toLowerCase()})` : ''} and asks you
      before anything that can’t be undone: decisions, cancellations, events and publishing.
    </Empty>
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
              className="h-7 min-w-0 flex-1 rounded-xl bg-transparent px-2 text-ui focus-visible:bg-background focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
  const shortcut = useShortcutLabel('J');
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
          placeholder={busy ? 'Next message, sent after this reply' : 'Ask the assistant'}
          aria-label="Message the assistant"
        />
        <PromptInputFooter className="gap-1.5 pt-0">
          <ScopeChip />
          <span className="flex-1" />
          {/* While a reply runs, stop sits beside send, which queues the next message. */}
          {busy ? (
            <PromptInputSubmit status="streaming" onStop={onStop} className="touch:size-9" />
          ) : null}
          <PromptInputSubmit disabled={!text.trim()} className="touch:size-9" />
        </PromptInputFooter>
      </PromptInput>
      <p className="mt-1.5 hidden px-1 text-muted-foreground text-xs fine:block">
        Enter sends · Shift+Enter for a new line · {shortcut} opens and closes
      </p>
    </div>
  );
}
