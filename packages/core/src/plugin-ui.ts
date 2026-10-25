/**
 * Plugin views: a plugin page answers with a description of the page (`PluginView`, as
 * `PLUGIN_VIEW_TYPE` JSON) instead of HTML, and the web app renders it in the app shell with its own
 * components: the same headers, sections, tables, forms and alerts as every OrderLoop page, light
 * and dark. The plugin sends data, never markup or script, so nothing it says runs in the browser.
 *
 * Links and form actions stay on the plugin's own pages (`/plugins/<id>/…`, relative to the page);
 * anything else is refused when the view is checked (`checkPluginView`).
 */

import { z } from 'zod';

/** The media type a plugin page answers with to be rendered in the app. */
export const PLUGIN_VIEW_TYPE = 'application/vnd.orderloop.view+json';

/** The largest view the web app reads. */
export const PLUGIN_VIEW_MAX_BYTES = 256 * 1024;

const text = (max = 2000) => z.string().max(max);
const tone = z.enum(['default', 'muted', 'ok', 'warning', 'bad']).default('default');

/**
 * Whether a path climbs or stays put anywhere (`..` or `.`, spelled out or as `%2e`, which a
 * browser resolves the same way), so it could leave the plugin's pages.
 */
const dotSegment = (path: string) =>
  path
    .split('?')[0]!
    .split('/')
    .some((s) => /^(\.|%2e){1,2}$/i.test(s));

/**
 * A link or form action: a path on the plugin's own pages, relative to them (`partners`,
 * `partners/ptn_1/rotate`) or absolute under `/plugins/<id>/`. Never another origin, a scheme, a
 * fragment, or a `.`/`..` segment.
 */
/** The characters a target may use: no scheme (`:`), backslash, space, fragment or markup. */
const TARGET = /^(?!\/\/)[A-Za-z0-9\-._~/?=&%]*$/;

const target = z
  .string()
  .min(1)
  .max(500)
  .regex(TARGET, 'A path on the plugin’s pages')
  .refine((t) => !dotSegment(t), { message: 'No . or .. in a path' });

const link = z.object({ label: text(120), href: target });

const cell = z.union([
  text(),
  z.number(),
  z.object({
    text: text(),
    href: target.optional(),
    tone: tone.optional(),
    mono: z.boolean().optional(),
  }),
]);

const field = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.\-[\]]{0,63}$/),
  label: text(200),
  kind: z
    .enum([
      'text',
      'textarea',
      'number',
      'email',
      'url',
      'date',
      'password',
      'select',
      'checkbox',
      'hidden',
    ])
    .default('text'),
  value: z.union([z.string().max(10_000), z.number(), z.boolean()]).optional(),
  options: z
    .array(z.object({ value: text(200), label: text(200) }))
    .max(200)
    .optional(),
  required: z.boolean().optional(),
  placeholder: text(200).optional(),
  hint: text(500).optional(),
});

/** A form: posted, as an ordinary form, to the plugin's own page `action`. */
const form = z.object({
  type: z.literal('form'),
  action: target,
  fields: z.array(field).max(50),
  submit: text(80),
  tone: z.enum(['default', 'danger']).default('default'),
  /** Asked before the form is sent (a browser confirm). */
  confirm: text(300).optional(),
});

const leaf = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: text(10_000), tone }),
  z.object({
    type: z.literal('alert'),
    tone: z.enum(['info', 'success', 'warning', 'error']).default('info'),
    title: text(200).optional(),
    text: text(),
  }),
  z.object({
    type: z.literal('stats'),
    items: z
      .array(z.object({ label: text(80), value: text(80), hint: text(200).optional() }))
      .max(12),
  }),
  z.object({
    type: z.literal('table'),
    columns: z
      .array(
        z.object({
          key: text(64),
          label: text(120),
          align: z.enum(['left', 'right']).default('left'),
        }),
      )
      .min(1)
      .max(12),
    rows: z
      .array(
        z.object({
          cells: z.record(z.string(), cell),
          /** Buttons for this row: each a small form (`rotate`, `disable`). */
          actions: z.array(form).max(4).optional(),
        }),
      )
      .max(500),
    empty: text(200).optional(),
  }),
  form,
  z.object({ type: z.literal('code'), label: text(200).optional(), text: text(10_000) }),
  z.object({ type: z.literal('list'), items: z.array(z.union([text(), link])).max(200) }),
]);

const section = z.object({
  type: z.literal('section'),
  title: text(200),
  description: text(500).optional(),
  blocks: z.array(leaf).max(50),
});

export const pluginViewSchema = z.object({
  title: text(200),
  description: text(1000).optional(),
  /** Links in the page header, to the plugin's other pages. */
  actions: z.array(link).max(6).optional(),
  blocks: z.array(z.discriminatedUnion('type', [section, leaf])).max(50),
});

export type PluginView = z.input<typeof pluginViewSchema>;
export type CheckedPluginView = z.output<typeof pluginViewSchema>;
export type PluginViewBlock = CheckedPluginView['blocks'][number];
export type PluginViewForm = z.output<typeof form>;
export type PluginViewCell = z.output<typeof cell>;

/** A plugin's view as the web app renders it, or why it can't be. */
export function checkPluginView(
  raw: string,
): { ok: true; view: CheckedPluginView } | { ok: false; error: string } {
  if (raw.length > PLUGIN_VIEW_MAX_BYTES) return { ok: false, error: 'The page is too large' };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'The page is not JSON' };
  }
  const parsed = pluginViewSchema.safeParse(json);
  if (!parsed.success) {
    const i = parsed.error.issues[0]!;
    return { ok: false, error: `${i.path.join('.') || 'page'}: ${i.message}` };
  }
  return { ok: true, view: parsed.data };
}

/**
 * Where a view's link or form goes: under `base` (`/plugins/<id>/`) for a relative target, or
 * as it is when it is already under it; null for anything else.
 */
export function pluginViewHref(base: string, target: string): string | null {
  const path = target.startsWith('/') ? target : `${base}${target}`;
  if (!/^\/plugins\/[a-z][a-z0-9-]*\/$/.test(base) || !TARGET.test(target)) return null;
  return path.startsWith(base) && !dotSegment(path) ? path : null;
}
