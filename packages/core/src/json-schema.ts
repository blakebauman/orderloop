/**
 * Checks a model's JSON answer against the JSON Schema it was asked to follow. JSON mode makes a
 * model try to; it doesn't guarantee it. Covers the keywords the AI nodes use: `type` (one or a
 * list), `enum`, `properties`, `required` and `items`. Unknown keywords are ignored.
 */
export function conforms(value: unknown, schema: Record<string, unknown>): boolean {
  const types = schema.type === undefined ? [] : ([] as unknown[]).concat(schema.type);
  if (types.length && !types.some((t) => isType(value, String(t)))) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) return false;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    if (required.some((k) => !(k in obj))) return false;
    const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    for (const [k, s] of Object.entries(props)) if (k in obj && !conforms(obj[k], s)) return false;
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object') {
    const items = schema.items as Record<string, unknown>;
    if (!value.every((v) => conforms(v, items))) return false;
  }
  return true;
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return !!value && typeof value === 'object' && !Array.isArray(value);
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}
