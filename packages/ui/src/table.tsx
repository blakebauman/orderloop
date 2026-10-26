import { ArrowDown, ArrowUp } from 'lucide-react';
import * as React from 'react';

import { cn } from './lib/utils';

/**
 * How a table reads below md. `cards`: each row becomes a card, its first cell (the thing the row
 * is about) on a line of its own and the rest wrapping beneath it, each named by its `label`.
 * `rows`: the caller lays the row out itself (a grid, say). Either way the header stays for screen
 * readers, and the parts keep their table roles, which WebKit drops once a row stops being
 * displayed as one.
 */
type Stack = 'cards' | 'rows';

const Stacked = React.createContext<Stack | undefined>(undefined);

/**
 * A data table in Ledger: caption headers, ruled rows, figures right-aligned and tabular. The
 * table pads its cells (app.css, at zero specificity, so a cell's own classes win): `edge="card"`
 * runs edge to edge in a card, its outer columns inset from the card's edge; `edge="flush"` lines
 * the outer columns up with the text around it, inside a padded panel.
 */
function Table({
  edge = 'card',
  stack,
  sticky,
  scroll,
  caption,
  className,
  children,
  ...props
}: React.ComponentProps<'table'> & {
  edge?: 'card' | 'flush';
  stack?: Stack;
  /** Keep the header under the top bar while a long list scrolls (from md; the page must scroll). */
  sticky?: boolean;
  /** Scroll sideways inside its container when the columns don't fit, rather than the page. */
  scroll?: boolean;
  /** What the table is, for screen readers (it isn't drawn): usually its section's title. */
  caption?: React.ReactNode;
}) {
  const table = (
    <Stacked.Provider value={stack}>
      <table
        data-slot="table"
        data-edge={edge}
        data-stack={stack}
        role={stack ? 'table' : undefined}
        className={cn(
          'w-full text-sm',
          stack === 'cards' && 'table-stack',
          sticky &&
            'md:[&>thead_th]:sticky md:[&>thead_th]:top-[var(--shell-h)] md:[&>thead_th]:z-10 md:[&>thead_th]:bg-card md:[&>thead_th]:shadow-[inset_0_-1px_var(--border)]',
          className,
        )}
        {...props}
      >
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        {children}
      </table>
    </Stacked.Provider>
  );
  return scroll ? <div className="overflow-x-auto">{table}</div> : table;
}

function TableHead({ className, ...props }: React.ComponentProps<'thead'>) {
  const stack = React.useContext(Stacked);
  return (
    <thead
      data-slot="table-head"
      role={stack ? 'rowgroup' : undefined}
      className={cn('border-b text-left', stack && 'max-md:sr-only', className)}
      {...props}
    />
  );
}

function TableBody({ className, ...props }: React.ComponentProps<'tbody'>) {
  const stack = React.useContext(Stacked);
  return (
    <tbody
      data-slot="table-body"
      role={stack ? 'rowgroup' : undefined}
      className={cn('divide-y', className)}
      {...props}
    />
  );
}

function TableFoot(props: React.ComponentProps<'tfoot'>) {
  const stack = React.useContext(Stacked);
  return <tfoot data-slot="table-foot" role={stack ? 'rowgroup' : undefined} {...props} />;
}

function Tr(props: React.ComponentProps<'tr'>) {
  const stack = React.useContext(Stacked);
  return <tr role={stack ? 'row' : undefined} {...props} />;
}

/**
 * A column header, as a caption. `numeric` right-aligns it over figures. `sort` marks the column
 * the rows are ordered by, with its direction drawn beside the label; pass a link as the children
 * to make it a sort control. A column with no name (row actions) still gets one, for screen
 * readers: pass `<span className="sr-only">Actions</span>`.
 */
function Th({
  numeric,
  sort,
  scope = 'col',
  className,
  children,
  ...props
}: React.ComponentProps<'th'> & {
  numeric?: boolean;
  sort?: 'ascending' | 'descending';
}) {
  const stack = React.useContext(Stacked);
  const Arrow = sort === 'ascending' ? ArrowUp : ArrowDown;
  return (
    <th
      scope={scope}
      role={stack ? (scope === 'col' ? 'columnheader' : 'rowheader') : undefined}
      aria-sort={sort}
      className={cn(
        'caption whitespace-nowrap text-left',
        numeric && 'text-right',
        sort && 'text-foreground',
        className,
      )}
      {...props}
    >
      {children}
      {sort ? <Arrow aria-hidden="true" className="ml-1 inline size-3 align-[-0.125em]" /> : null}
    </th>
  );
}

/**
 * A cell. `numeric` sets a figure: right-aligned, tabular, unbroken. `label` names the value when
 * the row stacks into a card on a phone (the first cell needs none: it heads the card).
 */
function Td({
  numeric,
  label,
  className,
  ...props
}: React.ComponentProps<'td'> & { numeric?: boolean; label?: string }) {
  const stack = React.useContext(Stacked);
  return (
    <td
      role={stack ? 'cell' : undefined}
      data-label={label}
      className={cn(numeric && 'whitespace-nowrap text-right tabular', className)}
      {...props}
    />
  );
}

/** A row that says why there are no rows here (a search that missed), across every column. */
function TableEmpty({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <Tr>
      <Td colSpan={colSpan} className="py-3 text-muted-foreground text-xs">
        {children}
      </Td>
    </Tr>
  );
}

export { Table, TableBody, TableEmpty, TableFoot, TableHead, Td, Th, Tr };
