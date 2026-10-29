import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@orderloop/ui/card';
import {
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  Empty as EmptyRoot,
  EmptyTitle,
} from '@orderloop/ui/empty';
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
          <p className="mt-1 max-w-measure text-muted-foreground text-sm">{subtitle}</p>
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

/**
 * A card with a title (Maia's Card: CardHeader, CardTitle, CardAction, CardContent). `flush` lets
 * content that brings its own rows (tables, ruled lists) run to the card's edges under a rule.
 */
export function Section({
  id,
  title,
  description,
  children,
  className,
  actions,
  flush,
}: {
  /** An in-page link target; it clears the sticky top bar (and a sticky jump bar) when jumped to. */
  id?: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  actions?: React.ReactNode;
  /** Drop the body padding for content that brings its own rows (tables, ruled lists). */
  flush?: boolean;
}) {
  return (
    <Card
      id={id}
      className={cn(
        // Clip, not hidden: hidden would make the card a scroll container and stop a sticky table
        // header at its top. Relative, so it also clips what's positioned inside it (a sort link's
        // hit area, a header's sr-only text), which would otherwise widen the page at large text.
        'relative min-w-0 scroll-mt-[calc(var(--shell-h)+3.5rem)] gap-4 overflow-clip [--card-spacing:--spacing(5)]',
        flush && 'pb-0',
        className,
      )}
    >
      {/* On a phone a description beside the actions would wrap a word to a line: the actions go
          under it instead. */}
      <CardHeader className={cn(description && actions && 'max-sm:grid-cols-1!')}>
        <CardTitle className="section-title">
          <h2>{title}</h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {actions ? (
          <CardAction
            className={cn(
              'self-center',
              description &&
                'max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-auto max-sm:justify-self-start',
            )}
          >
            {actions}
          </CardAction>
        ) : null}
      </CardHeader>
      {flush ? <div className="border-t">{children}</div> : <CardContent>{children}</CardContent>}
    </Card>
  );
}

/**
 * An empty state (Maia's Empty): what is (not) here, and optionally the next useful step. Inside a
 * card it stays compact; give it an `icon` and a `title` where the empty state is the page's news.
 */
export function Empty({
  children,
  action,
  icon,
  title,
  className,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  icon?: React.ReactNode;
  title?: React.ReactNode;
  className?: string;
}) {
  return (
    <EmptyRoot className={cn('gap-3 p-6', className)}>
      <EmptyHeader className="max-w-measure">
        {icon ? <EmptyMedia variant="icon">{icon}</EmptyMedia> : null}
        {title ? <EmptyTitle className="font-semibold text-base">{title}</EmptyTitle> : null}
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </EmptyRoot>
  );
}
