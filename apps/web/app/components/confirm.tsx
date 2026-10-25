import { Button } from '@orderloop/ui/button';
import { cn } from '@orderloop/ui/lib/utils';
import { type ReactNode, useEffect, useId, useRef } from 'react';

/** Open confirmations, newest last: Escape backs out of the newest one only. */
const open: symbol[] = [];

/**
 * An in-place "are you sure?", where the action was rather than in a modal. Focus lands on the safe
 * choice, Escape backs out, and focus goes back to what asked if the answer didn't move it. The
 * actions (the confirming button, and any field it needs) come as children, so it can sit inside
 * the caller's form.
 */
export function Confirm({
  message,
  note,
  cancelLabel = 'Cancel',
  onCancel,
  className,
  children,
}: {
  message: ReactNode;
  note?: ReactNode;
  cancelLabel?: string;
  onCancel: () => void;
  className?: string;
  children: ReactNode;
}) {
  const id = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  // The latest callback without re-running the effect, which would pull focus back to the safe
  // choice on every re-render.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  useEffect(() => {
    const me = Symbol();
    open.push(me);
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open.at(-1) === me && !e.defaultPrevented) {
        e.preventDefault();
        onCancelRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      open.splice(open.indexOf(me), 1);
      const now = document.activeElement;
      if ((!now || now === document.body) && before?.isConnected)
        before.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={`${id}-msg`}
      aria-describedby={note ? `${id}-note` : undefined}
      className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 text-sm', className)}
    >
      <p className="min-w-0 flex-1 basis-60">
        <span id={`${id}-msg`} className="font-medium">
          {message}
        </span>
        {note ? (
          <>
            {' '}
            <span id={`${id}-note`} className="text-muted-foreground">
              {note}
            </span>
          </>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button ref={cancel} size="sm" variant="ghost" type="button" onClick={onCancel}>
          {cancelLabel}
        </Button>
        {children}
      </div>
    </div>
  );
}
