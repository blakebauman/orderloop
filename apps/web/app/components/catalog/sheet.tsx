import {
  type FieldRef,
  fieldId,
  fieldValue,
  PRODUCT_STATUSES,
  type ProductSheet,
} from '@orderloop/core/product';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { cn } from '@orderloop/ui/lib/utils';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@orderloop/ui/sheet';
import { Table, TableBody, TableHead, Td, Th, Tr } from '@orderloop/ui/table';
import { Textarea } from '@orderloop/ui/textarea';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Ago } from '~/components/ago';
import { ToneBadge } from '~/components/status';
import { useMedia } from '~/lib/device';
import { humanize } from '~/lib/format';
import { DRAFTABLE, fieldLabel, issueText, sameRef } from './labels';
import { refusal, useCatalogAction } from './use-action';

type Base = Omit<FieldRef, 'locale'>;

/** The product type's attribute labels, by code, so every field on the sheet reads by its name. */
const AttributeLabels = createContext<Record<string, string>>({});
const useFieldLabel = () => {
  const labels = useContext(AttributeLabels);
  return (ref: Pick<FieldRef, 'field' | 'code' | 'src'>) => fieldLabel(ref, labels);
};

const isText = (v: unknown): v is Record<string, string> =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === 'string');

/** The fields the sheet lays out, and the locales across them, from everything the product has. */
function layout(s: ProductSheet): { rows: Base[]; locales: string[] } {
  const p = s.product;
  const refs = [
    ...s.gaps.flatMap((g) => (g.locale ? [{ id: g.field, locale: g.locale }] : [])),
    ...[...s.drafts, ...s.staged, ...s.overrides].map((x) => ({
      id: fieldId(x.ref),
      locale: x.ref.locale,
    })),
  ];
  const locales = new Set<string>();
  for (const l of [p.title, p.description, p.slug, ...Object.values(p.attributes).filter(isText)])
    for (const k of Object.keys(l ?? {})) locales.add(k);
  for (const m of p.media) for (const k of Object.keys(m.alt ?? {})) locales.add(k);
  for (const r of refs) if (r.locale) locales.add(r.locale);
  const named = (id: string) => refs.some((r) => r.id === id);
  const codes = new Set([
    ...Object.entries(p.attributes)
      .filter(([, v]) => isText(v))
      .map(([c]) => c),
    ...refs.filter((r) => r.id.startsWith('attr:')).map((r) => r.id.slice(5)),
  ]);
  const rows: Base[] = [
    { field: 'title' },
    ...(p.description || named('description') ? [{ field: 'description' as const }] : []),
    { field: 'slug' },
    ...[...codes].sort().map((code) => ({ field: 'attribute' as const, code })),
    ...p.media.map((m) => ({ field: 'mediaAlt' as const, src: m.src })),
  ];
  // The locales the product is written in come first (most fields filled), then the rest.
  const filled = (l: string) =>
    [p.title, p.description, p.slug, ...Object.values(p.attributes).filter(isText)].filter(
      (x) => x?.[l],
    ).length;
  return {
    rows,
    locales: [...locales].sort((a, b) => filled(b) - filled(a) || a.localeCompare(b)),
  };
}

/** The field that put the product on the board: a conflict, then a draft, then a gap. */
function focusRef(s: ProductSheet): FieldRef | undefined {
  return (
    s.overrides.find((o) => o.conflict)?.ref ??
    s.drafts[0]?.ref ??
    s.staged.find((x) => x.failure)?.ref ??
    s.gaps
      .filter((g) => g.locale)
      .map((g) => {
        const [kind, rest] = [g.field.split(':')[0], g.field.slice(g.field.indexOf(':') + 1)];
        if (kind === 'attr') return { field: 'attribute' as const, code: rest, locale: g.locale };
        if (kind === 'alt') return { field: 'mediaAlt' as const, src: rest, locale: g.locale };
        return { field: g.field as FieldRef['field'], locale: g.locale };
      })[0]
  );
}

const refKey = (r: FieldRef) => `${fieldId(r)}@${r.locale ?? ''}`;

/**
 * One product, opened from a card: every editable field in every locale side by side, each value
 * marked with where it comes from (the feed, an edit here, the assistant's draft, a staged edit, a
 * conflict, or nothing), the field that put it on the board in focus, then what the feed owns, the
 * refused row if there is one, and the recent changes. Editing and publishing are for a larger
 * screen; accepting or dropping a draft works anywhere.
 */
export function ProductSheetView({
  sheet,
  attributeLabels = {},
  canEdit,
  onClose,
}: {
  sheet: ProductSheet;
  /** Labels the product's type gives its attributes, by code. */
  attributeLabels?: Record<string, string>;
  canEdit: boolean;
  onClose: () => void;
}) {
  const p = sheet.product;
  const label = (ref: Pick<FieldRef, 'field' | 'code' | 'src'>) => fieldLabel(ref, attributeLabels);
  const { rows, locales } = layout(sheet);
  const focus = focusRef(sheet);
  const body = useRef<HTMLDivElement>(null);
  const focusKey = focus ? refKey(focus) : null;
  // Opening on the field that matters: scroll it into view once per product.
  useEffect(() => {
    if (!focusKey) return;
    // After the drawer has slid in: measured before, the cell is nowhere yet.
    const t = window.setTimeout(() => {
      // Scrolled by hand: scrollIntoView would also slide the drawer itself sideways.
      const cell = body.current?.querySelector<HTMLElement>(`[data-ref="${CSS.escape(focusKey)}"]`);
      const strip = cell?.closest<HTMLElement>('[data-strip]');
      const pane = body.current?.closest<HTMLElement>('[data-slot="sheet-content"]');
      if (!cell || !strip || !pane) return;
      const c = cell.getBoundingClientRect();
      const st = strip.getBoundingClientRect();
      const pa = pane.getBoundingClientRect();
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth';
      // Only as far as it takes: the locales on the left are what a draft is checked against.
      const label = strip.querySelector('th')?.getBoundingClientRect().width ?? 0;
      if (c.right > st.right) strip.scrollBy({ left: c.right - st.right + 16, behavior });
      else if (c.left < st.left + label)
        strip.scrollBy({ left: c.left - st.left - label, behavior });
      if (c.bottom > pa.bottom || c.top < pa.top)
        pane.scrollBy({ top: c.top - pa.top - pa.height / 3, behavior });
    }, 320);
    return () => window.clearTimeout(t);
  }, [p.key]);
  const title = Object.values(p.title)[0] ?? p.key;
  // A phone gets the bottom sheet, as every sheet there is; wider screens a side drawer.
  const phone = useMedia('(max-width: 639px)');
  const freshDrafts = sheet.drafts.filter((d) => !d.stale).length;
  const canDraft = sheet.gaps.some((g) => DRAFTABLE.has(g.kind));
  return (
    <AttributeLabels.Provider value={attributeLabels}>
      <Sheet open onOpenChange={(o) => !o && onClose()}>
        <SheetContent
          side={phone ? 'bottom' : 'right'}
          onOpenAutoFocus={(e) => {
            // Focus what put the product on the board (its first action), so Enter acts on it.
            const first = (e.currentTarget as HTMLElement).querySelector<HTMLElement>(
              '[data-ref-focus] button',
            );
            if (first) {
              e.preventDefault();
              first.focus({ preventScroll: true });
            }
          }}
          className="w-full gap-0 overflow-x-hidden overflow-y-auto overscroll-contain sm:max-w-2xl xl:max-w-4xl"
        >
          <SheetHeader className="gap-1 border-b px-6 pt-6 pb-4">
            <SheetTitle className="pr-8 font-semibold text-lg tracking-title">{title}</SheetTitle>
            <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-mono text-xs">{p.key}</span>
              <span aria-hidden="true">·</span>
              <span>{humanize(p.status)}</span>
              <span aria-hidden="true">·</span>
              <span>
                version {p.version}, changed <Ago ms={p.updatedAt} />
              </span>
            </SheetDescription>
            {canEdit ? (
              <Toolbar
                productKey={p.key}
                canDraft={canDraft}
                drafts={freshDrafts}
                staged={sheet.staged.length}
              />
            ) : null}
          </SheetHeader>

          <div ref={body} className="flex flex-col gap-6 px-6 py-5">
            {sheet.rejection ? (
              <section aria-labelledby="refused" className="tile flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <ToneBadge tone="bad" label="Refused" />
                  <h3 id="refused" className="font-medium text-sm">
                    The feed’s last row for this product was refused
                    {sheet.rejection.row !== undefined ? ` (row ${sheet.rejection.row})` : ''}
                  </h3>
                </div>
                <ul className="flex flex-col gap-1 text-sm">
                  {sheet.rejection.issues.map((i) => (
                    <li key={`${i.path}:${i.message}`}>
                      {issueText(i)}
                      {i.path ? (
                        <span className="ml-2 font-mono text-2xs text-muted-foreground">
                          {i.path}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="text-muted-foreground text-xs">
                  Fix it at the source: the next feed that sends a valid row for{' '}
                  <span className="font-mono">{p.key}</span> clears this. What’s live below is the
                  last row the catalog took.
                </p>
              </section>
            ) : null}

            <StatusField sheet={sheet} canEdit={canEdit} />

            <section aria-labelledby="content">
              <h3 id="content" className="caption mb-2">
                Content
              </h3>
              {canEdit ? (
                <p className="mb-3 text-muted-foreground text-xs lg:hidden">
                  Review and accept drafts here; editing and publishing are on a larger screen.
                </p>
              ) : null}
              {/* A phone stacks each field's locales; anything wider sets them side by side. */}
              <div className="flex flex-col divide-y sm:hidden">
                {rows.map((base) => (
                  <div key={fieldId(base as FieldRef)} className="py-3">
                    <p className="mb-2 font-medium text-sm">
                      {label(base)}
                      {base.field === 'attribute' ? (
                        <span className="ml-2 font-mono font-normal text-2xs text-muted-foreground">
                          {base.code}
                        </span>
                      ) : null}
                      {base.field === 'mediaAlt' ? (
                        <span className="ml-2 font-mono font-normal text-2xs text-muted-foreground">
                          {base.src?.split('/').at(-1)}
                        </span>
                      ) : null}
                    </p>
                    <dl className="flex flex-col gap-3">
                      {locales.map((locale) => (
                        <div key={locale} className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
                          <dt className="pt-0.5 font-mono text-muted-foreground text-xs">
                            {locale}
                          </dt>
                          <dd className="min-w-0">
                            <FieldCell
                              sheet={sheet}
                              fieldRef={{ ...base, locale } as FieldRef}
                              canEdit={canEdit}
                              focused={false}
                              anchor={false}
                            />
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ))}
              </div>
              <div data-strip className="-mx-6 overflow-x-auto px-6 max-sm:hidden">
                <Table edge="flush" className="w-full">
                  <TableHead>
                    <Tr>
                      <Th scope="col" className="sticky left-0 z-10 w-28 bg-popover sm:w-36">
                        <span className="sr-only">Field</span>
                      </Th>
                      {locales.map((l) => (
                        <Th key={l} scope="col" className="min-w-44">
                          <span className="font-mono normal-case tracking-normal">{l}</span>
                        </Th>
                      ))}
                    </Tr>
                  </TableHead>
                  <TableBody>
                    {rows.map((base) => (
                      <Tr key={fieldId(base as FieldRef)} className="align-top">
                        <Th
                          scope="row"
                          className="sticky left-0 z-10 w-28 bg-popover align-top font-normal normal-case tracking-normal text-foreground sm:w-36"
                        >
                          <span className="block text-sm">{label(base)}</span>
                          {base.field === 'attribute' ? (
                            <span className="block font-mono text-2xs normal-case tracking-normal text-muted-foreground">
                              {base.code}
                            </span>
                          ) : null}
                          {base.field === 'mediaAlt' ? (
                            <span
                              className="block max-w-36 truncate font-mono text-2xs normal-case tracking-normal text-muted-foreground"
                              title={base.src}
                            >
                              {base.src?.split('/').at(-1)}
                            </span>
                          ) : null}
                        </Th>
                        {locales.map((locale) => {
                          const ref = { ...base, locale } as FieldRef;
                          return (
                            <Td key={locale} className="align-top">
                              <FieldCell
                                sheet={sheet}
                                fieldRef={ref}
                                canEdit={canEdit}
                                focused={focusKey === refKey(ref)}
                              />
                            </Td>
                          );
                        })}
                      </Tr>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>

            <FeedFacts sheet={sheet} />
            <History sheet={sheet} />
          </div>
        </SheetContent>
      </Sheet>
    </AttributeLabels.Provider>
  );
}

function Toolbar({
  productKey,
  canDraft,
  drafts,
  staged,
}: {
  productKey: string;
  canDraft: boolean;
  drafts: number;
  staged: number;
}) {
  const draft = useCatalogAction();
  const accept = useCatalogAction();
  const pub = useCatalogAction();
  const requestId = useRef<string | null>(null);
  const done = draft.answer?.ok ? draft.answer.draft : undefined;
  const published = pub.answer?.ok
    ? (pub.answer.results?.[0] as { status?: string; issues?: string[] })
    : undefined;
  useEffect(() => {
    if (pub.answer) requestId.current = null;
  }, [pub.answer]);
  const note =
    refusal(draft.answer) ??
    refusal(accept.answer) ??
    refusal(pub.answer) ??
    (done
      ? `Drafted ${done.drafted.length} ${done.drafted.length === 1 ? 'field' : 'fields'}${
          done.refused.length ? `; ${done.refused.length} couldn’t be` : ''
        }${done.more ? `; ${done.more} more left for another request` : ''}.`
      : published?.status === 'failed'
        ? `Didn’t publish: ${published.issues?.join('; ')}`
        : published?.status === 'published'
          ? 'Published.'
          : null);
  if (!canDraft && !drafts && !staged && !note) return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      {canDraft ? (
        <Button
          size="sm"
          variant="outline"
          className="max-lg:hidden"
          disabled={draft.busy}
          onClick={() => draft.run({ intent: 'draft', key: productKey })}
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-ai" />
          {draft.busy ? 'Drafting…' : 'Draft missing text'}
        </Button>
      ) : null}
      {drafts ? (
        <Button
          size="sm"
          variant="outline"
          disabled={accept.busy}
          onClick={() => accept.run({ intent: 'accept', key: productKey })}
        >
          Accept {drafts} {drafts === 1 ? 'draft' : 'drafts'}
        </Button>
      ) : null}
      {staged ? (
        <Button
          size="sm"
          className="max-lg:hidden"
          disabled={pub.busy}
          onClick={() => {
            requestId.current ??= crypto.randomUUID();
            pub.run({ intent: 'publish', keys: [productKey], requestId: requestId.current });
          }}
        >
          {pub.busy ? 'Publishing…' : `Publish ${staged} ${staged === 1 ? 'edit' : 'edits'}`}
        </Button>
      ) : null}
      {note ? (
        <p role="status" className="basis-full text-muted-foreground text-xs">
          {note}
        </p>
      ) : null}
    </div>
  );
}

function StatusField({ sheet, canEdit }: { sheet: ProductSheet; canEdit: boolean }) {
  const act = useCatalogAction();
  const ref: FieldRef = { field: 'status' };
  const staged = sheet.staged.find((x) => sameRef(x.ref, ref));
  const value = staged?.value ?? sheet.product.status;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="caption" id="status-label">
        Status
      </span>
      {canEdit ? (
        <span className="max-lg:hidden">
          <NativeSelect
            aria-labelledby="status-label"
            className="w-36"
            value={value}
            disabled={act.busy}
            onChange={(e) =>
              act.run({
                intent: 'stage',
                edits: [{ key: sheet.product.key, ref, op: 'set', value: e.target.value }],
              })
            }
          >
            {PRODUCT_STATUSES.map((s) => (
              <NativeSelectOption key={s} value={s}>
                {humanize(s)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </span>
      ) : null}
      <span className={cn('text-sm', canEdit && 'lg:hidden')}>{humanize(value)}</span>
      {staged ? <Marker tone="staged" /> : null}
      {refusal(act.answer) ? <span className="text-bad text-xs">{refusal(act.answer)}</span> : null}
    </div>
  );
}

type Source = 'feed' | 'edited' | 'draft' | 'stale' | 'staged' | 'failed' | 'conflict' | 'missing';

const MARKER: Record<Source, { label: string; dot?: string }> = {
  feed: { label: 'From feed' },
  edited: { label: 'Edited here', dot: 'var(--foreground)' },
  draft: { label: 'Draft', dot: 'var(--ai)' },
  stale: { label: 'Draft, field changed since', dot: 'var(--wait)' },
  staged: { label: 'Staged', dot: 'var(--foreground)' },
  failed: { label: 'Didn’t publish', dot: 'var(--bad)' },
  conflict: { label: 'Conflict', dot: 'var(--wait)' },
  missing: { label: 'Missing', dot: 'var(--wait)' },
};

function Marker({ tone }: { tone: Source }) {
  const m = MARKER[tone];
  return (
    <span className="inline-flex items-center gap-1.5 font-medium text-2xs text-muted-foreground">
      {m.dot ? (
        <span aria-hidden="true" className="size-1.5 rounded-full" style={{ background: m.dot }} />
      ) : null}
      {m.label}
    </span>
  );
}

/** One field in one locale: its value, where it comes from, and what can be done with it. */
function FieldCell({
  sheet,
  fieldRef: ref,
  canEdit,
  focused,
  anchor = true,
}: {
  sheet: ProductSheet;
  fieldRef: FieldRef;
  canEdit: boolean;
  focused: boolean;
  /** Whether opening the sheet may scroll to it: only one rendering of a cell is. */
  anchor?: boolean;
}) {
  const key = sheet.product.key;
  const label = useFieldLabel();
  const act = useCatalogAction();
  const [editing, setEditing] = useState<string | null>(null);
  const live = fieldValue(sheet.product, ref);
  const override = sheet.overrides.find((o) => sameRef(o.ref, ref));
  const staged = sheet.staged.find((x) => sameRef(x.ref, ref));
  const draft = sheet.drafts.find((d) => sameRef(d.ref, ref));
  const gap = sheet.gaps.find((g) => g.field === fieldId(ref) && g.locale === ref.locale);
  const source: Source = staged
    ? staged.failure
      ? 'failed'
      : 'staged'
    : draft
      ? draft.stale
        ? 'stale'
        : 'draft'
      : override?.conflict
        ? 'conflict'
        : override
          ? 'edited'
          : live
            ? 'feed'
            : 'missing';
  // A field with nothing anywhere and no gap isn't worth a cell's worth of chrome.
  const quiet = source === 'missing' && !gap;
  const shown =
    source === 'staged' || source === 'failed'
      ? staged?.op === 'clear'
        ? (override?.feed ?? null)
        : (staged?.value ?? null)
      : source === 'draft' || source === 'stale'
        ? (draft?.value ?? null)
        : live;
  const stage = (value: string | null, op: 'set' | 'clear' = 'set', from?: 'assistant') =>
    act.run({
      intent: 'stage',
      edits: [
        { key, ref, op, ...(op === 'set' ? { value } : {}), ...(from ? { source: from } : {}) },
      ],
    });
  const long = ref.field === 'description';
  const error = refusal(act.answer);
  return (
    <div
      data-ref={anchor ? refKey(ref) : undefined}
      data-ref-focus={anchor && focused ? '' : undefined}
      className={cn(
        '-my-1.5 -ml-1.5 flex flex-col gap-1.5 rounded-xl p-1.5',
        focused && 'bg-muted/60 ring-1 ring-ring/40',
      )}
    >
      {quiet ? (
        <span className="text-muted-foreground text-sm">
          <span aria-hidden="true">—</span>
          <span className="sr-only">Empty</span>
        </span>
      ) : (
        <Marker tone={source} />
      )}
      {editing !== null ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing.trim()) stage(editing.trim());
            setEditing(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setEditing(null);
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              e.currentTarget.requestSubmit();
            }
          }}
        >
          {long ? (
            <Textarea
              autoFocus
              aria-label={`${label(ref)}, ${ref.locale}`}
              rows={6}
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
            />
          ) : (
            <Input
              autoFocus
              aria-label={`${label(ref)}, ${ref.locale}`}
              value={editing}
              onChange={(e) => setEditing(e.target.value)}
            />
          )}
          <div className="flex gap-1.5">
            <Button size="xs" type="submit" disabled={!editing.trim()}>
              Stage
            </Button>
            <Button size="xs" variant="ghost" type="button" onClick={() => setEditing(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : shown !== null ? (
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-sm',
            long && 'line-clamp-6',
            ref.field === 'slug' && 'font-mono text-xs',
          )}
        >
          {shown}
        </p>
      ) : source === 'staged' ? (
        <p className="text-muted-foreground text-sm">Removed</p>
      ) : null}

      {source === 'conflict' && override ? (
        <p className="text-muted-foreground text-xs">
          The feed now says: <span className="text-foreground">{override.feed ?? 'nothing'}</span>
        </p>
      ) : null}
      {source === 'stale' && draft ? (
        <p className="text-muted-foreground text-xs">
          Drafted against “{draft.seen ?? 'nothing'}”; it reads “{live ?? 'nothing'}” now.
        </p>
      ) : null}
      {source === 'failed' && staged?.failure ? (
        <p className="text-bad text-xs">{staged.failure}</p>
      ) : null}

      {canEdit && editing === null ? (
        <div className="flex flex-wrap gap-1.5">
          {draft ? (
            <>
              <Button
                size="xs"
                variant="outline"
                disabled={act.busy}
                onClick={() => stage(draft.value, 'set', 'assistant')}
              >
                Accept
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={act.busy}
                onClick={() => act.run({ intent: 'discard-drafts', items: [{ key, ref }] })}
              >
                Drop
              </Button>
              <Button
                size="xs"
                variant="ghost"
                className="max-lg:hidden"
                onClick={() => setEditing(draft.value)}
              >
                Edit
              </Button>
            </>
          ) : staged ? (
            <Button
              size="xs"
              variant="ghost"
              className="max-lg:hidden"
              disabled={act.busy}
              onClick={() => act.run({ intent: 'discard-staged', items: [{ key, ref }] })}
            >
              Unstage
            </Button>
          ) : (
            <span className="contents max-lg:hidden">
              {source === 'conflict' && override ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={act.busy}
                  onClick={() => stage(override.value)}
                >
                  Keep mine
                </Button>
              ) : null}
              {override ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={act.busy}
                  onClick={() => stage(null, 'clear')}
                >
                  Use feed value
                </Button>
              ) : null}
              <Button size="xs" variant="ghost" onClick={() => setEditing(live ?? '')}>
                {live ? 'Edit' : 'Write'}
              </Button>
              {gap && DRAFTABLE.has(gap.kind) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={act.busy}
                  onClick={() => act.run({ intent: 'draft', key, fields: [ref] })}
                >
                  <span aria-hidden="true" className="size-1.5 rounded-full bg-ai" />
                  Draft
                </Button>
              ) : null}
            </span>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-bad text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** What the feed owns and the page can't change: variants, channels, categories, media. */
function FeedFacts({ sheet }: { sheet: ProductSheet }) {
  const p = sheet.product;
  const facts: [string, React.ReactNode][] = [
    [
      'Variants',
      <span key="v">
        {p.variants.length}{' '}
        <span className="font-mono text-muted-foreground text-xs">
          {p.variants
            .slice(0, 4)
            .map((v) => v.sku)
            .join(', ')}
          {p.variants.length > 4 ? ', …' : ''}
        </span>
      </span>,
    ],
    [
      'Channels',
      <span key="c" className="font-mono text-xs">
        {Object.keys(p.channels).join(', ') || 'none'}
      </span>,
    ],
    [
      'Categories',
      <span key="g" className="font-mono text-xs">
        {p.categories.join(', ') || 'none'}
      </span>,
    ],
    ['Media', `${p.media.length}`],
  ];
  return (
    <section aria-labelledby="feed-owns">
      <h3 id="feed-owns" className="caption mb-2">
        From the feed, not edited here
      </h3>
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {facts.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function History({ sheet }: { sheet: ProductSheet }) {
  const label = useFieldLabel();
  if (!sheet.revisions.length) return null;
  return (
    <section aria-labelledby="history">
      <h3 id="history" className="caption mb-2">
        Published changes
      </h3>
      <ol className="flex flex-col divide-y text-sm">
        {sheet.revisions.slice(0, 8).map((r) => (
          <li
            key={`${refKey(r.ref)}:${r.at}`}
            className="flex flex-wrap items-baseline gap-x-2 py-1.5"
          >
            {r.source === 'assistant' ? (
              <span aria-hidden="true" className="size-1.5 rounded-full bg-ai" />
            ) : null}
            <span className="font-medium">
              {label(r.ref)}
              {r.ref.locale ? (
                <span className="font-mono text-muted-foreground text-xs"> {r.ref.locale}</span>
              ) : null}
            </span>
            <span className="text-muted-foreground">
              {r.op === 'clear' ? 'back to the feed value' : r.value === null ? 'removed' : 'set'}
              {r.source === 'assistant' ? ' from a draft' : ''} by {r.by}, <Ago ms={r.at} />
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
