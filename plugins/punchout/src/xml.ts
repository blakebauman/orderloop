/**
 * A small, strict XML reader for cXML, with no dependencies. cXML documents are small and plain:
 * elements, attributes, text and CDATA. Anything that could make a parser do more than read is
 * refused: a DOCTYPE with an internal subset (`[`), entities other than the five predefined and
 * numeric references, and documents over `MAX_XML_BYTES` or nested deeper than `MAX_DEPTH`.
 */

export const MAX_XML_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_ELEMENTS = 50_000;

export type XmlElement = {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  /** The element's own text (CDATA included), trimmed. */
  text: string;
};

export class XmlError extends Error {}

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;
// No prototype: `&toString;` is not an entity.
const ENTITIES: Record<string, string> = Object.assign(Object.create(null), {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
});

function decode(raw: string): string {
  return raw.replace(/&([^;\s&]{1,10});/g, (_, ref: string) => {
    if (Object.hasOwn(ENTITIES, ref)) return ENTITIES[ref]!;
    const code = /^#x[0-9a-f]+$/i.test(ref)
      ? Number.parseInt(ref.slice(2), 16)
      : /^#\d+$/.test(ref)
        ? Number(ref.slice(1))
        : Number.NaN;
    if (!Number.isInteger(code) || code < 0x9 || code > 0x10ffff)
      throw new XmlError(`Unknown entity &${ref};`);
    return String.fromCodePoint(code);
  });
}

/** Reads `xml` into its root element, or throws `XmlError`. */
export function parseXml(xml: string): XmlElement {
  if (xml.length > MAX_XML_BYTES) throw new XmlError('The document is too large');
  if (
    /&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(
      xml.replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ''),
    )
  )
    throw new XmlError('Unknown entity');
  let i = 0;
  let count = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;
  const fail = (m: string): never => {
    throw new XmlError(`${m} at ${i}`);
  };
  const at = (s: string) => xml.startsWith(s, i);
  const skipTo = (s: string) => {
    const j = xml.indexOf(s, i);
    if (j < 0) fail(`Expected ${s}`);
    i = j + s.length;
  };
  while (i < xml.length) {
    if (at('<?')) skipTo('?>');
    else if (at('<!--')) skipTo('-->');
    else if (at('<!DOCTYPE')) {
      const end = xml.indexOf('>', i);
      if (end < 0) fail('Unclosed DOCTYPE');
      if (xml.slice(i, end).includes('[')) fail('A DOCTYPE with an internal subset is refused');
      if (root || stack.length) fail('A DOCTYPE after the root');
      i = end + 1;
    } else if (at('<![CDATA[')) {
      const end = xml.indexOf(']]>', i);
      if (end < 0) fail('Unclosed CDATA');
      const top = stack.at(-1) ?? fail('Text outside the root');
      top.text += xml.slice(i + 9, end);
      i = end + 3;
    } else if (at('</')) {
      i += 2;
      const name = NAME.exec(xml.slice(i))?.[0] ?? fail('Bad closing tag');
      i += name.length;
      while (/\s/.test(xml[i] ?? '')) i++;
      if (xml[i] !== '>') fail('Bad closing tag');
      i++;
      const top = stack.pop();
      if (!top || top.name !== name) fail(`Mismatched </${name}>`);
      top!.text = top!.text.trim();
      if (!stack.length) root = top!;
    } else if (at('<')) {
      i++;
      const name = NAME.exec(xml.slice(i))?.[0] ?? fail('Bad tag');
      i += name.length;
      const el: XmlElement = { name, attrs: {}, children: [], text: '' };
      if (++count > MAX_ELEMENTS) fail('Too many elements');
      for (;;) {
        while (/\s/.test(xml[i] ?? '')) i++;
        if (at('/>') || at('>')) break;
        const attr = NAME.exec(xml.slice(i))?.[0] ?? fail('Bad attribute');
        i += attr.length;
        while (/\s/.test(xml[i] ?? '')) i++;
        if (xml[i] !== '=') fail('Expected =');
        i++;
        while (/\s/.test(xml[i] ?? '')) i++;
        const q = xml[i];
        if (q !== '"' && q !== "'") fail('Expected a quoted value');
        const end = xml.indexOf(q!, i + 1);
        if (end < 0) fail('Unclosed attribute');
        const value = xml.slice(i + 1, end);
        if (value.includes('<')) fail('< in an attribute');
        el.attrs[attr] = decode(value);
        i = end + 1;
      }
      const parent = stack.at(-1);
      if (!parent && root) fail('A second root');
      parent?.children.push(el);
      if (at('/>')) {
        i += 2;
        if (!parent) root = el;
      } else {
        i++;
        stack.push(el);
        if (stack.length > MAX_DEPTH) fail('Nested too deep');
      }
    } else {
      const end = xml.indexOf('<', i);
      const text = xml.slice(i, end < 0 ? xml.length : end);
      const top = stack.at(-1);
      if (top) top.text += decode(text);
      else if (text.trim()) fail('Text outside the root');
      i = end < 0 ? xml.length : end;
    }
  }
  if (stack.length || !root) throw new XmlError('The document ends early');
  return root;
}

/** The first child named `name`. */
export const child = (el: XmlElement | undefined, name: string) =>
  el?.children.find((c) => c.name === name);

/** Every child named `name`. */
export const children = (el: XmlElement | undefined, name: string) =>
  el?.children.filter((c) => c.name === name) ?? [];

/** The element at `path` (`Header/From/Credential`) under `el`. */
export function at(el: XmlElement | undefined, path: string): XmlElement | undefined {
  return path.split('/').reduce<XmlElement | undefined>((e, name) => child(e, name), el);
}

/** Text and attribute values, escaped for XML. */
export const esc = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => `&${{ '<': 'lt', '>': 'gt', '&': 'amp', '"': 'quot', "'": 'apos' }[c]};`,
  );
