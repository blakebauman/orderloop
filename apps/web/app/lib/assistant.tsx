/**
 * The assistant panel's state, shared by the shell and the pages under it: whether the panel is
 * open, what the page in front of it is about (the context chip), and proposals on their way to the
 * flow editor. The panel lives in the shell, so a conversation and a pending proposal survive
 * navigation between pages.
 */

import type { AssistantContext, FlowProposal } from '@orderloop/core';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/** The page's own context, read when a message is sent so it carries the latest unsaved graph. */
type PageContext = () => AssistantContext;

type Scope = 'page' | 'workspace';

type AssistantState = {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Opens the panel and puts the cursor in its prompt. */
  focus: () => void;
  /** Asks a question as if typed, opening the panel. */
  ask: (text: string) => void;
  pendingAsk: string | null;
  takeAsk: () => string | null;
  focusToken: number;
  /** What the page is about, when it says; workspace otherwise. */
  page: AssistantContext;
  readPage: () => AssistantContext;
  /** "page" follows the page in front; "workspace" asks about everything. */
  scope: Scope;
  setScope: (s: Scope) => void;
  register: (read: PageContext) => () => void;
  /** A proposal handed to the flow editor; the editor takes it when it is open on that flow. */
  proposal: FlowProposal | null;
  offerProposal: (p: FlowProposal) => void;
  takeProposal: (flowId: string) => FlowProposal | null;
  /** Bumped when a proposal is offered, so an open editor notices. */
  proposalToken: number;
};

const WORKSPACE: AssistantContext = { kind: 'workspace' };
const Ctx = createContext<AssistantState | null>(null);

const OPEN_KEY = 'ol-assistant-open';

export function AssistantProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = useState(false);
  const [scope, setScope] = useState<Scope>('page');
  const [focusToken, setFocusToken] = useState(0);
  const [pendingAsk, setPendingAsk] = useState<string | null>(null);
  const [page, setPage] = useState<AssistantContext>(WORKSPACE);
  const reader = useRef<PageContext | null>(null);
  const [proposal, setProposal] = useState<FlowProposal | null>(null);
  const [proposalToken, setProposalToken] = useState(0);

  // Reopen the panel on the next visit if it was open; a convenience, so storage may fail.
  useEffect(() => {
    try {
      if (
        localStorage.getItem(OPEN_KEY) === '1' &&
        window.matchMedia('(min-width: 1024px)').matches
      )
        setOpenState(true);
    } catch {
      // Storage blocked: the panel starts closed.
    }
  }, []);
  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try {
      localStorage.setItem(OPEN_KEY, next ? '1' : '0');
    } catch {
      // Storage blocked: remembered for this visit only.
    }
  }, []);

  const register = useCallback((read: PageContext) => {
    reader.current = read;
    setPage(read());
    return () => {
      if (reader.current === read) {
        reader.current = null;
        setPage(WORKSPACE);
      }
    };
  }, []);

  const value = useMemo<AssistantState>(
    () => ({
      open,
      setOpen,
      focus: () => {
        setOpen(true);
        setFocusToken((n) => n + 1);
      },
      ask: (text) => {
        setPendingAsk(text);
        setOpen(true);
        setFocusToken((n) => n + 1);
      },
      pendingAsk,
      takeAsk: () => {
        const t = pendingAsk;
        setPendingAsk(null);
        return t;
      },
      focusToken,
      page,
      readPage: () => (scope === 'workspace' ? WORKSPACE : (reader.current?.() ?? WORKSPACE)),
      scope,
      setScope,
      register,
      proposal,
      offerProposal: (p) => {
        setProposal(p);
        setProposalToken((n) => n + 1);
      },
      takeProposal: (flowId) => {
        if (!proposal || proposal.flowId !== flowId) return null;
        setProposal(null);
        return proposal;
      },
      proposalToken,
    }),
    [open, setOpen, pendingAsk, focusToken, page, scope, register, proposal, proposalToken],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAssistant(): AssistantState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAssistant needs AssistantProvider (the shell renders it)');
  return v;
}

/**
 * Tells the assistant what this page is about while it is mounted. `read` runs when a message is
 * sent; `deps` re-announce the chip's label when they change.
 */
export function usePageContext(read: PageContext, deps: unknown[]) {
  const { register } = useAssistant();
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => register(() => latest.current()), [register, ...deps]);
}

/** The label the chip shows for a context. */
export function contextLabel(c: AssistantContext): string {
  if (c.kind === 'order') return c.label;
  if (c.kind === 'flow') return c.label;
  return 'Everything';
}
