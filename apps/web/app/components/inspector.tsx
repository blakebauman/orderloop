/**
 * Node inspector: a form generated from the node's catalog fields, plus label, retries and timeout.
 * JSON Logic and JSON fields are edited as text and only committed when they parse.
 */

import {
  type ConfigField,
  type FlowNode,
  type NodeRun,
  nodeOutputs,
  nodeSpec,
  withDefaults,
} from '@orderloop/core';
import { Button } from '@orderloop/ui/button';
import { Input } from '@orderloop/ui/input';
import { NativeSelect, NativeSelectOption } from '@orderloop/ui/native-select';
import { Switch } from '@orderloop/ui/switch';
import { Textarea } from '@orderloop/ui/textarea';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CATEGORY_COLOR, NodeIcon } from './node-icon';

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
    <label className="block">
      <span className="mb-1 flex items-baseline justify-between gap-2">
        <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          {label}
        </span>
        {hint ? (
          <span className="truncate text-[11px] text-muted-foreground/70">{hint}</span>
        ) : null}
      </span>
      {children}
    </label>
  );
}

export function Inspector({
  node,
  run,
  onChange,
  onDelete,
}: {
  node: FlowNode;
  run?: NodeRun;
  onChange?: (n: FlowNode) => void;
  onDelete?: () => void;
}) {
  const spec = nodeSpec(node.type);
  const config = withDefaults(node.type, node.config);
  const readOnly = !onChange;
  const set = (key: string, value: unknown) =>
    onChange?.({ ...node, config: { ...node.config, [key]: value } });

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2.5">
        {spec ? (
          <span
            className="grid size-8 shrink-0 place-items-center rounded-lg"
            style={{
              background: `color-mix(in oklch, ${CATEGORY_COLOR[spec.category]} 16%, transparent)`,
              color: CATEGORY_COLOR[spec.category],
            }}
          >
            <NodeIcon name={spec.icon} className="size-4" />
          </span>
        ) : null}
        <div className="min-w-0">
          <div className="font-semibold text-sm">{spec?.label ?? node.type}</div>
          <p className="text-muted-foreground text-xs leading-snug">{spec?.description}</p>
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
        <div className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
          Outputs
        </div>
        <div className="flex flex-wrap gap-1">
          {nodeOutputs(node.type, config).map((o) => (
            <span key={o} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
              {o}
            </span>
          ))}
          {spec?.loop ? (
            <span className="rounded bg-wait/15 px-1.5 py-0.5 font-mono text-[11px] text-wait">
              ← next
            </span>
          ) : null}
          {spec?.rollback ? (
            <span className="rounded bg-undo/15 px-1.5 py-0.5 text-[11px] text-undo">
              compensated on failure
            </span>
          ) : null}
        </div>
      </div>

      {run && run.status !== 'pending' ? (
        <div className="rounded-lg border bg-muted/30 p-3">
          <div className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Last run
          </div>
          <div className="mt-1 text-sm">
            {run.status} {run.runs > 1 ? `· ${run.runs} runs` : ''}{' '}
            {run.branches?.length ? `→ ${run.branches.join(', ')}` : ''}
          </div>
          {run.summary ? (
            <div className="mt-1 text-muted-foreground text-xs">{run.summary}</div>
          ) : null}
          {run.error ? <div className="mt-1 text-bad text-xs">{run.error}</div> : null}
          {run.output !== undefined ? (
            <pre className="mt-2 max-h-56 overflow-auto rounded bg-background/60 p-2 font-mono text-[11px]">
              {JSON.stringify(run.output, null, 2)}
            </pre>
          ) : null}
        </div>
      ) : null}

      {onDelete ? (
        <Button variant="ghost" size="sm" className="text-bad hover:text-bad" onClick={onDelete}>
          <Trash2 /> Delete node
        </Button>
      ) : null}
    </div>
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
    case 'boolean':
      return (
        <div className="flex items-center justify-between gap-3">
          <Field label={f.label} hint={f.hint}>
            <span />
          </Field>
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
        className="font-mono text-[11px]"
      />
      {error ? <span className="mt-1 block text-[11px] text-wait">{error}</span> : null}
    </Field>
  );
}
