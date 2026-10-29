/**
 * A cart's chat in the assistant panel (its Thread), for staff: the same messages, typing and
 * editing as the cart page had, beside the assistant. **Draft a reply** has the assistant draft
 * the next message from the thread (`draft_cart_reply`); it fills the composer and nothing is sent
 * until the person sends it.
 */

import type { CartChatMessage, CartState, CartTyping } from '@orderloop/core';
import { useAgent } from 'agents/react';
import { useEffect, useState } from 'react';
import { Chat } from '~/components/cart-view';
import { useAssistant } from '~/lib/assistant';
import {
  NO_TYPISTS,
  nextTypingEnd,
  type Typists,
  typingAt,
  typingLabel,
  typingSeen,
} from '~/lib/cart-typing';
import { useMe } from '~/lib/use-me';

type Result = { ok: true } | { ok: false; error: string };

export function CartThread({ cartId }: { cartId: string }) {
  const me = useMe();
  const { act } = useAssistant();
  const [chat, setChat] = useState<CartChatMessage[]>([]);
  const [external, setExternal] = useState(false);
  const [typists, setTypists] = useState<Typists>(NO_TYPISTS);
  const meId = me?.id ?? null;
  const agent = useAgent<CartState>({
    agent: 'cart-agent',
    name: cartId,
    onStateUpdate: (s) => {
      setChat(s.chat);
      setExternal(!!s.cart?.external);
    },
    onMessage: (e) => {
      let m: Partial<CartTyping> | null = null;
      try {
        m = typeof e.data === 'string' ? JSON.parse(e.data) : null;
      } catch {}
      if (m?.type === 'cart_typing')
        setTypists((t) => typingSeen(t, m as CartTyping, meId, Date.now()));
    },
  });
  useEffect(() => {
    const end = nextTypingEnd(typists);
    if (end === null) return;
    const t = window.setTimeout(
      () => setTypists((x) => typingAt(x, Math.max(Date.now(), end))),
      Math.max(0, end - Date.now()),
    );
    return () => window.clearTimeout(t);
  }, [typists]);

  const call = async <T,>(method: string, args: unknown[]) => {
    try {
      return (await agent.call(method, args)) as T;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) } as T;
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <Chat
        title={external ? 'Chat · the buyer sees it' : 'Chat'}
        messages={chat}
        myId={meId}
        typing={typingLabel(typists)}
        onTyping={() => {
          if (agent.readyState === WebSocket.OPEN) void agent.call('typing').catch(() => {});
        }}
        onSay={(body) =>
          call<{ ok: true; id: string } | { ok: false; error: string }>('say', [body])
        }
        onEdit={(id, body) => call<Result>('edit', [id, body])}
        onDelete={(id) => call<Result>('unsay', [id])}
        onOlder={async (before) =>
          ((await agent.call('history', [before])) as CartChatMessage[]) ?? []
        }
        onDraftReply={async () => {
          try {
            const r = await act('draft_cart_reply', { cartId });
            const draft = 'output' in r ? (r.output as { draft?: string } | null)?.draft : null;
            return draft ? { draft } : { error: 'Nothing was drafted.' };
          } catch (e) {
            return { error: e instanceof Error ? e.message : String(e) };
          }
        }}
      />
    </div>
  );
}
