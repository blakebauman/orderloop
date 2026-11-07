import {
  flowReadsGoodsBack,
  type OrderLine,
  RETURN_NOTE_MAX,
  RETURN_REASON_CODES,
  RETURN_REASONS,
  type ReturnInput,
  type ReturnReason,
  returnRequest,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Field, FieldDescription, FieldLabel } from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import {
  NativeSelect,
  NativeSelectOptGroup,
  NativeSelectOption,
} from '@orderloop/ui/native-select';
import { Textarea } from '@orderloop/ui/textarea';
import { useState } from 'react';
import { FormSheet } from '~/components/form-sheet';

const STEPS = ['Reason', 'Items', 'Details'] as const;

/**
 * A return or claim, one question at a time. It ends on the assistant's card, which is the review:
 * the engine checks the request again there and shows what will happen before anyone confirms.
 */
export function ReturnSheet({
  order,
  flow,
  disabled,
  onSubmit,
}: {
  order: { lines: OrderLine[]; total?: number };
  flow: { nodes: unknown[] } | null | undefined;
  disabled: boolean;
  onSubmit: (input: ReturnInput) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <FormSheet
      open={open}
      onOpenChange={setOpen}
      label="Record a return or claim"
      description="You confirm what happens next on the assistant's card."
    >
      <ReturnForm
        order={order}
        flow={flow}
        disabled={disabled}
        onSubmit={(input) => {
          setOpen(false);
          return onSubmit(input);
        }}
      />
    </FormSheet>
  );
}

function ReturnForm({
  order,
  flow,
  disabled,
  onSubmit,
}: {
  order: { lines: OrderLine[]; total?: number };
  flow: { nodes: unknown[] } | null | undefined;
  disabled: boolean;
  onSubmit: (input: ReturnInput) => Promise<unknown>;
}) {
  const [step, setStep] = useState(0);
  const [reasonCode, setReasonCode] = useState<ReturnReason | ''>('');
  const [qty, setQty] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  // A flow without the branch would wait for goods that never come, and end with no refund.
  const offered = RETURN_REASON_CODES.filter(
    (c) => RETURN_REASONS[c].goodsBack || flowReadsGoodsBack(flow),
  );
  const skus = [...new Map(order.lines.map((l) => [l.sku, l])).values()];
  const ordered = (sku: string) =>
    order.lines.filter((l) => l.sku === sku).reduce((n, l) => n + l.qty, 0);

  const input: ReturnInput | null = reasonCode
    ? {
        reasonCode,
        lines: Object.entries(qty)
          .map(([sku, n]) => ({ sku, qty: Number(n) }))
          .filter((l) => l.qty !== 0),
        ...(amount.trim() ? { amount: Number(amount) } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }
    : null;
  const checked = input ? returnRequest(input, order) : null;
  const issue = checked && 'issue' in checked ? checked.issue : null;
  const request = checked && 'request' in checked ? checked.request : null;
  const itemsChosen = !!input?.lines.length;
  const canContinue = step === 0 ? !!reasonCode : itemsChosen;

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (step < STEPS.length - 1) {
          if (canContinue) setStep(step + 1);
        } else if (input && request) void onSubmit(input);
      }}
    >
      <p className="text-muted-foreground text-xs">
        Step {step + 1} of {STEPS.length}: {STEPS[step]}
      </p>

      {step === 0 ? (
        <Field>
          <FieldLabel htmlFor="return-reason">What happened?</FieldLabel>
          <NativeSelect
            id="return-reason"
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value as ReturnReason | '')}
          >
            <NativeSelectOption value="">Choose a reason</NativeSelectOption>
            {(['return', 'claim'] as const).map((kind) => (
              <NativeSelectOptGroup key={kind} label={kind === 'return' ? 'Return' : 'Claim'}>
                {offered
                  .filter((c) => RETURN_REASONS[c].kind === kind)
                  .map((c) => (
                    <NativeSelectOption key={c} value={c}>
                      {RETURN_REASONS[c].label}
                    </NativeSelectOption>
                  ))}
              </NativeSelectOptGroup>
            ))}
          </NativeSelect>
          {reasonCode ? (
            <FieldDescription>
              {RETURN_REASONS[reasonCode].goodsBack
                ? 'The buyer gets a return label and sends the items back.'
                : 'Nothing comes back, so the refund goes straight out.'}
            </FieldDescription>
          ) : null}
        </Field>
      ) : null}

      {step === 1
        ? skus.map((l) => (
            <Field key={l.sku}>
              <FieldLabel htmlFor={`return-${l.sku}`}>{l.name ?? l.sku}</FieldLabel>
              <Input
                id={`return-${l.sku}`}
                type="number"
                inputMode="numeric"
                min={0}
                max={ordered(l.sku)}
                value={qty[l.sku] ?? ''}
                placeholder="0"
                onChange={(e) => setQty({ ...qty, [l.sku]: e.target.value })}
              />
              <FieldDescription>{ordered(l.sku)} ordered</FieldDescription>
            </Field>
          ))
        : null}

      {step === 2 ? (
        <>
          <Field>
            <FieldLabel htmlFor="return-amount">Amount to refund</FieldLabel>
            <Input
              id="return-amount"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              value={amount}
              placeholder={request ? String(request.amount) : ''}
              onChange={(e) => setAmount(e.target.value)}
            />
            <FieldDescription>Leave empty to refund what the items cost.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="return-note">Note</FieldLabel>
            <Textarea
              id="return-note"
              maxLength={RETURN_NOTE_MAX}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </>
      ) : null}

      {step > 0 && issue ? (
        <p role="alert" className="text-bad text-xs">
          {issue}
        </p>
      ) : null}

      <div className="flex justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={step === 0}
          onClick={() => setStep(step - 1)}
        >
          Back
        </Button>
        {step < STEPS.length - 1 ? (
          <Button type="submit" size="sm" disabled={!canContinue}>
            Continue
          </Button>
        ) : (
          <Button type="submit" size="sm" disabled={disabled || !request}>
            Review on the card
          </Button>
        )}
      </div>
    </form>
  );
}
