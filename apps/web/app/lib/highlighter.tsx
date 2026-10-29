/**
 * Syntax colour for the code block (`components/code.tsx`), after shadcn's highlighter: Shiki with
 * its JavaScript regex engine (no WebAssembly), imported on the first block that shows, with each
 * grammar loaded the first time it's used. The theme is Shiki's CSS-variables theme, so the colours
 * are Ledger's own (`--shiki-*` in app.css, light and dark) rather than another product's.
 */

import type { ReactNode } from 'react';
import type { GrammarState, HighlighterCore } from 'shiki/core';

const languages = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
};

export type Language = keyof typeof languages;

let highlighter: Promise<HighlighterCore> | undefined;

function getHighlighter() {
  highlighter ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(
    ([{ createHighlighterCore, createCssVariablesTheme }, { createJavaScriptRegexEngine }]) =>
      createHighlighterCore({
        themes: [createCssVariablesTheme({ name: 'ledger', variablePrefix: '--shiki-' })],
        langs: [],
        engine: createJavaScriptRegexEngine({ forgiving: true }),
      }),
  );
  return highlighter;
}

/** One React node per line and the grammar state after the last; pass the state back to go on. */
export type Highlight = (
  code: string,
  state?: GrammarState,
) => {
  lines: ReactNode[][];
  state: GrammarState | undefined;
};

/** A highlighter for `lang`, once Shiki and its grammar have loaded. */
export async function loadHighlighter(lang: Language): Promise<Highlight> {
  const shiki = await getHighlighter();
  if (!shiki.getLoadedLanguages().includes(lang)) await shiki.loadLanguage(languages[lang]);
  return (code, state) => {
    const tokens = shiki.codeToTokens(code, { lang, theme: 'ledger', grammarState: state }).tokens;
    return {
      lines: tokens.map((line) =>
        line.map((token, i) => (
          <span key={i} style={{ color: token.color }}>
            {token.content}
          </span>
        )),
      ),
      state: shiki.getLastGrammarState(tokens),
    };
  };
}
