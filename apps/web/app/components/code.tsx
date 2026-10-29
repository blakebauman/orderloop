/**
 * Code to read, in shadcn's Code Block: monospaced lines with a copy button, coloured once the
 * highlighter has loaded (`lib/highlighter.tsx`). Until then, and on the server, it is the same
 * lines in plain text, so nothing moves when the colour arrives.
 */

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockCopyButton,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from '@orderloop/ui/code-block';
import { type ReactNode, useEffect, useState } from 'react';
import type { Language } from '~/lib/highlighter';

export function Code({
  value,
  language,
  title,
  wrap,
  className,
  contentClassName,
}: {
  value: string;
  language: Language;
  /** Named in a header beside the copy button; without one, the button floats in the corner. */
  title?: ReactNode;
  wrap?: boolean;
  className?: string;
  /** For the scrolling area, e.g. a `max-h-*`. */
  contentClassName?: string;
}) {
  // A trailing newline would draw an empty last line.
  const code = value.endsWith('\n') ? value.slice(0, -1) : value;
  const [coloured, setColoured] = useState<{ code: string; lines: ReactNode[][] } | null>(null);

  useEffect(() => {
    let live = true;
    import('~/lib/highlighter')
      .then(({ loadHighlighter }) => loadHighlighter(language))
      .then((highlight) => {
        if (live) setColoured({ code, lines: highlight(code).lines });
      })
      // Without colour it is still the code: say nothing.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [code, language]);

  const lines: ReactNode[] = coloured?.code === code ? coloured.lines : code.split('\n');
  const copy = (
    <CodeBlockActions>
      <CodeBlockCopyButton value={code} />
    </CodeBlockActions>
  );
  return (
    <CodeBlock size="sm" className={className}>
      {title ? (
        <CodeBlockHeader>
          <CodeBlockTitle>{title}</CodeBlockTitle>
          {copy}
        </CodeBlockHeader>
      ) : (
        copy
      )}
      <CodeBlockContent wrap={wrap} className={contentClassName}>
        {lines.map((line, i) => (
          <CodeBlockLine key={i}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  );
}
