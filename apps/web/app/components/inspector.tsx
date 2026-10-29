/**
 * Node inspector: a form generated from the node's catalog fields, plus label, retries and timeout.
 * JSON Logic and JSON fields are edited as text and only committed when they parse.
 */

import type { ConfigField, FlowNode, NodeRun } from '@orderloop/core';
import {
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  Field as FieldRoot,
} from '@orderloop/ui/field';
import { Input } from '@orderloop/ui/input';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@orderloop/ui/item';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Switch } from '@orderloop/ui/switch';
import { Textarea } from '@orderloop/ui/textarea';
import { cloneElement, useEffect, useId, useState } from 'react';
import { Code } from '~/components/code';
import { plainSummary, statusLabel } from '~/lib/format';
import { useNodes } from '~/lib/nodes';
import { CATEGORY_COLOR, NodeIcon } from './node-icon';

/**
 * One setting: its label, the control (given the label's id, and the hint as its description) and
 * the hint beneath it. `*:w-auto` lets a control keep its own width; inputs fill by default.
 */
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();
  const hintId = useId();
  const controlId = children.props.id ?? id;
  return (
    <FieldRoot className="min-w-0 gap-1.5 *:w-auto">
      <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
      {cloneElement(children, {
        id: controlId,
        'aria-describedby': hint ? hintId : undefined,
      })}
      {hint ? (
        <FieldDescription id={hintId} className="text-xs leading-snug">
          {hint}
        </FieldDescription>
      ) : null}
    </FieldRoot>
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
    <div className="flex flex-col gap-6">
      {/* The step's own name leads; its type and what the type does sit beneath. */}
      <Item size="xs" className="items-start p-0">
        {spec ? (
          <ItemMedia
            className="size-8 rounded-md"
            style={{
              background: `color-mix(in oklch, ${CATEGORY_COLOR[spec.category]} 16%, transparent)`,
              color: CATEGORY_COLOR[spec.category],
            }}
          >
            <NodeIcon name={spec.icon} className="size-4" />
          </ItemMedia>
        ) : null}
        <ItemContent className="min-w-0">
          <ItemTitle className="line-clamp-none font-semibold">
            {node.label || spec?.label || node.type}
          </ItemTitle>
          <ItemDescription className="line-clamp-none text-xs leading-snug">
            <span className="font-medium text-foreground/80">{spec?.label ?? node.type}</span>
            {spec?.description ? ` · ${spec.description}` : ''}
          </ItemDescription>
        </ItemContent>
      </Item>

      <FieldGroup className="gap-4">
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
      </FieldGroup>

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
        <div>
          <h2 className="section-title mb-1.5">Last run</h2>
          <Item variant="muted" size="sm" className="items-start">
            <ItemContent className="min-w-0">
              <ItemTitle className="line-clamp-none font-normal">
                {statusLabel(run.status)}
                {run.runs > 1 ? ` · ${run.runs} runs` : ''}
                {run.branches?.length ? ` · took ${run.branches.join(', ')}` : ''}
              </ItemTitle>
              {run.summary ? (
                <ItemDescription className="line-clamp-none text-xs">
                  {plainSummary(run.summary)}
                </ItemDescription>
              ) : null}
              {run.error ? <p className="text-bad text-sm">{run.error}</p> : null}
              {run.output !== undefined ? (
                <Code
                  value={JSON.stringify(run.output, null, 2)}
                  language="json"
                  className="mt-1"
                  contentClassName="max-h-56"
                />
              ) : null}
            </ItemContent>
          </Item>
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
        className="h-8"
        wrapperClassName="w-full"
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
      return <BooleanInput field={f} value={value} readOnly={readOnly} onChange={onChange} />;
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
            className="h-8"
            wrapperClassName="w-full"
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
    <div className="flex flex-col gap-1">
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
      </Field>
      {error ? <span className="block text-wait text-xs">{error}</span> : null}
    </div>
  );
}

/** A switch beside its label and hint, which name and describe it. */
function BooleanInput({
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
  const id = useId();
  const hintId = useId();
  return (
    <FieldRoot orientation="horizontal" className="min-w-0 items-start justify-between">
      <FieldContent className="min-w-0">
        <FieldLabel htmlFor={id}>{f.label}</FieldLabel>
        {f.hint ? (
          <FieldDescription id={hintId} className="text-xs leading-snug">
            {f.hint}
          </FieldDescription>
        ) : null}
      </FieldContent>
      <Switch
        id={id}
        checked={Boolean(value)}
        disabled={readOnly}
        onCheckedChange={(v) => onChange(v)}
        aria-describedby={f.hint ? hintId : undefined}
        className="mt-0.5"
      />
    </FieldRoot>
  );
}
