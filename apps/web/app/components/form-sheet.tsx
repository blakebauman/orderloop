import { Button } from '@orderloop/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@orderloop/ui/sheet';
import { Plus } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useMedia } from '~/lib/device';

/**
 * A create form behind one button, so a list page shows the list rather than a form nobody is
 * filling in. The form is mounted only while the sheet is open: closing it clears the fields, and a
 * refusal keeps it open with what was typed. The caller owns `open`, to close it once the action
 * succeeds. From the side on a wide screen; from the bottom on a phone, where it pads for the home
 * indicator.
 */
export function FormSheet({
  open,
  onOpenChange,
  label,
  title,
  description,
  onCloseAutoFocus,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button that opens it, e.g. "New promotion". */
  label: string;
  /** The sheet's heading, when it says more than the button. */
  title?: string;
  description?: ReactNode;
  /** Where focus goes as it closes, when not back to its button: `preventDefault` and move it. */
  onCloseAutoFocus?: (e: Event) => void;
  children: ReactNode;
}) {
  const phone = useMedia('(max-width: 639px)');
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>
        <Button size="sm">
          <Plus aria-hidden="true" /> {label}
        </Button>
      </SheetTrigger>
      <SheetContent
        side={phone ? 'bottom' : 'right'}
        className="gap-0 overflow-y-auto sm:max-w-md"
        onCloseAutoFocus={onCloseAutoFocus}
        // With no description, say so, rather than point at one that isn't there.
        {...(description ? {} : { 'aria-describedby': undefined })}
      >
        <SheetHeader className="gap-1 border-b pt-4 pr-14 pb-3">
          <SheetTitle className="font-semibold text-base tracking-title">
            {title ?? label}
          </SheetTitle>
          {description ? (
            <SheetDescription className="text-xs">{description}</SheetDescription>
          ) : null}
        </SheetHeader>
        <div className="p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

/**
 * A form sheet's state from the page's action result: it closes once `done` says the result is the
 * form's success, and `result` is only what came back since the sheet last opened, so an old
 * refusal isn't shown again on a fresh form.
 */
export function useFormSheet<T>(result: T | undefined, done: (r: T) => boolean) {
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(result);
  const doneRef = useRef(done);
  doneRef.current = done;
  useEffect(() => {
    if (result && doneRef.current(result)) setOpen(false);
  }, [result]);
  return {
    open,
    onOpenChange: (o: boolean) => {
      if (o) setSeen(result);
      setOpen(o);
    },
    result: result === seen ? undefined : result,
  };
}
