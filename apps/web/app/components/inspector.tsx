/**
 * Node inspector: a form generated from the node's catalog fields, plus label, retries and timeout.
 * JSON Logic and JSON fields are edited as text and only committed when they parse.
 */

import type { ConfigField, FlowNode, NodeRun } from '@orderloop/core';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Switch } from '@orderloop/ui/switch';
import { Textarea } from '@orderloop/ui/textarea';
import { useEffect, useState } from 'react';
import { plainSummary, statusLabel } from '~/lib/format';
import { useNodes } from '~/lib/nodes';
import { CATEGORY_COLOR, NodeIcon } from './node-icon';

const SHORT_HINT = 32;

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children, inside the label
    <label className="block min-w-0">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="caption">{label}</span>
        {hint && hint.length <= SHORT_HINT ? (
          <span className="truncate text-muted-foreground text-xs">{hint}</span>
        ) : null}
      </span>
      {/* A hint too long for the label's line wraps beneath it rather than being cut off. */}
      {hint && hint.length > SHORT_HINT ? (
        <span className="mb-1.5 block text-muted-foreground text-xs leading-snug">{hint}</span>
      ) : null}
      {children}
    </label>
  );
}

export function Inspector({
  node,
  run,
  onChange,
}: {
  node: FlowNode;
  run?: NodeRun;
  onChange?: (n: FlowNode) => void;
}) {
  const nodes = useNodes();
  const spec = nodes.spec(node.type);
  const config = nodes.withDefaults(node.type, node.config);
  const readOnly = !onChange;
  const set = (key: string, value: unknown) =>
    onChange?.({ ...node, config: { ...node.config, [key]: value } });

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5">
        {spec ? (
          <span
            className="grid size-8 shrink-0 place-items-center rounded-md"
            style={{
              background: `color-mix(in oklch, ${CATEGORY_COLOR[spec.category]} 16%, transparent)`,
              color: CATEGORY_COLOR[spec.category],
            }}
          >
            <NodeIcon name={spec.icon} className="size-4" />
          </span>
        ) : null}
        {/* The step's own name leads; its type and what the type does sit beneath. */}
        <div className="min-w-0">
          <div className="font-semibold text-sm">{node.label || spec?.label || node.type}</div>
          <p className="text-muted-foreground text-xs leading-snug">
            <span className="font-medium text-foreground/80">{spec?.label ?? node.type}</span>
            {spec?.description ? ` · ${spec.description}` : ''}
          </p>
        </div>
      </div>

      <Field label="Label">
        <Input
          value={node.label}
          disabled={readOnly}
          onChange={(e) => onChange?.({ ...node, label: e.target.value })}
          className="h-8"
        />
      </Field>
      <Field label="Node id" hint="used in expressions: nodes.<id>">
        <Input value={node.id} disabled className="h-8 font-mono text-xs" />
      </Field>

      {spec?.fields.map((f) => (
        <ConfigInput
          key={`${node.id}:${f.key}`}
          field={f}
          value={config[f.key]}
          readOnly={readOnly}
          onChange={(v) => set(f.key, v)}
        />
      ))}

      {spec?.category === 'commerce' || spec?.category === 'ai' ? (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Retries">
            <Input
              type="number"
              min={0}
              max={10}
              disabled={readOnly}
              value={node.retries ?? spec.retries ?? 3}
              onChange={(e) => onChange?.({ ...node, retries: Number(e.target.value) })}
              className="h-8"
            />
          </Field>
          <Field label="Timeout">
            <Input
              disabled={readOnly}
              value={node.timeout ?? '5 minutes'}
              onChange={(e) => onChange?.({ ...node, timeout: e.target.value })}
              className="h-8"
            />
          </Field>
        </div>
      ) : null}

      <div>
        <h2 className="section-title mb-1.5">Outputs</h2>
        <div className="flex flex-wrap gap-1">
          {nodes.outputs(node.type, config).map((o) => (
            <span key={o} className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
              {o}
            </span>
          ))}
          {spec?.loop ? (
            <span className="rounded border border-[var(--ink)] border-dashed px-1.5 py-0.5 font-mono text-xs">
              next (loop back)
            </span>
          ) : null}
          {spec?.rollback ? (
            <span className="rounded bg-undo/15 px-1.5 py-0.5 text-undo text-xs">
              compensated on failure
            </span>
          ) : null}
        </div>
      </div>

      {run && run.status !== 'pending' ? (
        <div className="rounded-md border bg-muted/30 p-3">
          <h2 className="section-title">Last run</h2>
          <div className="mt-1 text-sm">
            {statusLabel(run.status)}
            {run.runs > 1 ? ` · ${run.runs} runs` : ''}
            {run.branches?.length ? ` · took ${run.branches.join(', ')}` : ''}
          </div>
          {run.summary ? (
            <div className="mt-1 text-muted-foreground text-xs">{plainSummary(run.summary)}</div>
          ) : null}
          {run.error ? <div className="mt-1 text-bad text-sm">{run.error}</div> : null}
          {run.output !== undefined ? (
            <pre className="mt-2 max-h-56 overflow-auto rounded bg-background/60 p-2 font-mono text-xs">
              {JSON.stringify(run.output, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** Built in, or an installed plugin providing the field's surface; a missing one stays listed. */
function ProviderSelect({
  field: f,
  value,
  readOnly,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const nodes = useNodes();
  const current = String(value ?? 'builtin') || 'builtin';
  const providers = f.surface ? nodes.providers(f.surface) : [];
  const listed = current === 'builtin' || providers.some((p) => p.id === current);
  return (
    <Field label={f.label} hint={f.hint}>
      <NativeSelect
        disabled={readOnly}
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 w-full"
      >
        <NativeSelectOption value="builtin">Built in</NativeSelectOption>
        {providers.map((p) => (
          <NativeSelectOption key={p.id} value={p.id}>
            {p.name}
          </NativeSelectOption>
        ))}
        {listed ? null : (
          <NativeSelectOption value={current}>{current} (not installed)</NativeSelectOption>
        )}
      </NativeSelect>
    </Field>
  );
}

function ConfigInput({
  field: f,
  value,
  readOnly,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  switch (f.kind) {
    case 'provider':
      return <ProviderSelect field={f} value={value} readOnly={readOnly} onChange={onChange} />;
    case 'boolean':
      return (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <Field label={f.label} hint={f.hint}>
              <span />
            </Field>
          </div>
          <Switch
            checked={Boolean(value)}
            disabled={readOnly}
            onCheckedChange={(v) => onChange(v)}
          />
        </div>
      );
    case 'number':
      return (
        <Field label={f.label} hint={f.hint}>
          <Input
            type="number"
            step="any"
            disabled={readOnly}
            value={Number(value ?? 0)}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-8"
          />
        </Field>
      );
    case 'select':
      return (
        <Field label={f.label} hint={f.hint}>
          <NativeSelect
            disabled={readOnly}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-full"
          >
            {(f.options ?? []).map((o) => (
              <NativeSelectOption key={o} value={o}>
                {o}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      );
    case 'textarea':
      return (
        <Field label={f.label} hint={f.hint}>
          <Textarea
            disabled={readOnly}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            rows={4}
            className="text-xs"
          />
        </Field>
      );
    case 'list':
      return (
        <Field label={f.label} hint="comma-separated">
          <Input
            disabled={readOnly}
            defaultValue={Array.isArray(value) ? value.join(', ') : ''}
            onBlur={(e) =>
              onChange(
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
            className="h-8 font-mono text-xs"
          />
        </Field>
      );
    case 'logic':
    case 'json':
      return <JsonInput field={f} value={value} readOnly={readOnly} onChange={onChange} />;
    case 'duration':
      return (
        <Field label={f.label} hint={f.hint ?? 'e.g. 2 days'}>
          <Input
            disabled={readOnly}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="h-8"
          />
        </Field>
      );
    default:
      return (
        <Field label={f.label} hint={f.hint}>
          <Input
            disabled={readOnly}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
            className="h-8"
          />
        </Field>
      );
  }
}

function JsonInput({
  field: f,
  value,
  readOnly,
  onChange,
}: {
  field: ConfigField;
  value: unknown;
  readOnly: boolean;
  onChange: (v: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setText(JSON.stringify(value ?? null, null, 2)), [value]);
  return (
    <Field
      label={f.label}
      hint={f.kind === 'logic' ? 'JSON Logic over {order, nodes, vars}' : f.hint}
    >
      <Textarea
        disabled={readOnly}
        value={text}
        rows={Math.min(8, text.split('\n').length + 1)}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            setError(null);
            onChange(v);
          } catch {
            setError('Not valid JSON yet');
          }
        }}
        className="font-mono text-xs"
      />
      {error ? <span className="mt-1 block text-wait text-xs">{error}</span> : null}
    </Field>
  );
}
