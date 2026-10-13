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
    <header className="mx-auto flex w-full max-w-[1400px] flex-wrap items-end justify-between gap-3 px-6 pt-7 pb-5">
      <div className="min-w-0">
        {crumbs ? <div className="eyebrow mb-1">{crumbs}</div> : null}
        <h1 className="truncate font-semibold text-2xl tracking-tight">{title}</h1>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-muted-foreground text-sm">{subtitle}</p>
        ) : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Page body width, matching the header. */
export function Body({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1400px] px-6 pb-10', className)}>{children}</div>
  );
}

export function Section({
  title,
  children,
  className,
  actions,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
}) {
  return (
    <section className={cn('rounded-md border bg-card', className)}>
      <div className="flex items-center justify-between border-b px-4 py-2">
        <h2 className="eyebrow">{title}</h2>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: string;
}) {
  return (
    <div className="border-l-2 py-1 pl-3" style={{ borderColor: tone ?? 'var(--rule)' }}>
      <div className="eyebrow">{label}</div>
      <div className="mt-0.5 font-mono font-semibold text-2xl tabular">{value}</div>
      {hint ? <div className="text-muted-foreground text-xs">{hint}</div> : null}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
      {children}
    </div>
  );
}
