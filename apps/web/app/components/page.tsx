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
    <header className="mx-auto flex w-full max-w-[1400px] flex-wrap items-end justify-between gap-3 px-4 pt-7 pb-5 sm:px-6">
      <div className="min-w-0">
        {crumbs ? <div className="caption mb-1">{crumbs}</div> : null}
        <h1 className="truncate font-semibold tracking-title text-[1.75rem] leading-tight">
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
    <div className={cn('mx-auto w-full min-w-0 max-w-[1400px] px-4 pb-10 sm:px-6', className)}>
      {children}
    </div>
  );
}

export function Section({
  title,
  children,
  className,
  actions,
  flush,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
  /** Drop the body padding for content that brings its own rows (tables, ruled lists). */
  flush?: boolean;
}) {
  return (
    <section className={cn('min-w-0 rounded-md border bg-card', className)}>
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2.5">
        <h2 className="section-title">{title}</h2>
        {actions}
      </div>
      <div className={flush ? undefined : 'p-4'}>{children}</div>
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
