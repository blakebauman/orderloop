import { cn } from '@orderloop/ui/lib/utils';

export function PageHeader({
  title,
  subtitle,
  actions,
  crumbs,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  crumbs?: React.ReactNode;
}) {
  return (
    <header className="mx-auto flex w-full max-w-page flex-wrap items-end justify-between gap-3 px-4 pt-7 pb-5 sm:px-6">
      <div className="min-w-0">
        {crumbs ? <div className="caption mb-1">{crumbs}</div> : null}
        <h1 className="break-words font-semibold tracking-title text-[1.75rem] leading-tight">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 max-w-[68ch] text-muted-foreground text-sm">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Page body width, matching the header. */
export function Body({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full min-w-0 max-w-page px-4 pb-10 sm:px-6', className)}>
      {children}
    </div>
  );
}

export function Section({
  id,
  title,
  children,
  className,
  actions,
  flush,
}: {
  /** An in-page link target; it clears the sticky top bar (and a sticky jump bar) when jumped to. */
  id?: string;
  title: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
  /** Drop the body padding for content that brings its own rows (tables, ruled lists). */
  flush?: boolean;
}) {
  return (
    <section
      id={id}
      className={cn(
        // Flush content runs to the edges, so the card clips it to its corners.
        'card min-w-0 scroll-mt-[calc(var(--shell-h)+3.5rem)]',
        flush && 'overflow-hidden',
        className,
      )}
    >
      <div className="flex min-h-14 items-center justify-between gap-3 px-5 pt-4 pb-2">
        <h2 className="section-title">{title}</h2>
        {actions}
      </div>
      <div className={flush ? 'border-t' : 'px-5 pb-5'}>{children}</div>
    </section>
  );
}

/** An empty state: what is (not) here, and optionally the next useful step. */
export function Empty({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-8 text-center text-muted-foreground text-sm">
      <p>{children}</p>
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
