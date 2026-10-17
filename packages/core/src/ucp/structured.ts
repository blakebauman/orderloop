/**
 * Just enough of RFC 8941 (Structured Field Values) for UCP's headers: `UCP-Agent` and the HTTP
 * message signature headers (`Signature-Input`, `Signature`) are Dictionaries whose members are
 * strings, tokens, integers, byte sequences, booleans or inner lists, each with parameters.
 * Parsing is strict: anything malformed returns null rather than a best guess.
 */

export type BareItem = string | number | boolean | Uint8Array | { token: string };
export type Params = Record<string, BareItem>;
export type Item = { value: BareItem; params: Params };
export type InnerList = { items: Item[]; params: Params };
export type Member = Item | InnerList;
export type Dictionary = Map<string, Member>;

export const isInnerList = (m: Member): m is InnerList => 'items' in m;

class Parser {
  i = 0;
  constructor(readonly s: string) {}
  peek() {
    return this.s[this.i];
  }
  done() {
    return this.i >= this.s.length;
  }
  skipSp() {
    while (this.s[this.i] === ' ') this.i++;
  }
  skipOws() {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
  }
  key(): string {
    const m = /^[a-z*][a-z0-9_\-.*]*/.exec(this.s.slice(this.i));
    if (!m) throw new SyntaxError('key');
    this.i += m[0].length;
    return m[0];
  }
  bare(): BareItem {
    const c = this.peek();
    if (c === '"') return this.string();
    if (c === ':') return this.bytes();
    if (c === '?') return this.boolean();
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.number();
    if (c !== undefined && /[A-Za-z*]/.test(c)) return this.token();
    throw new SyntaxError('item');
  }
  string(): string {
    this.i++;
    let out = '';
    while (!this.done()) {
      const c = this.s[this.i++]!;
      if (c === '\\') {
        const n = this.s[this.i++];
        if (n !== '"' && n !== '\\') throw new SyntaxError('escape');
        out += n;
      } else if (c === '"') return out;
      else if (c < ' ' || c > '~') throw new SyntaxError('string');
      else out += c;
    }
    throw new SyntaxError('unterminated string');
  }
  bytes(): Uint8Array {
    this.i++;
    const end = this.s.indexOf(':', this.i);
    if (end < 0) throw new SyntaxError('bytes');
    const b64 = this.s.slice(this.i, end);
    if (!/^[A-Za-z0-9+/=]*$/.test(b64)) throw new SyntaxError('bytes');
    this.i = end + 1;
    return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  }
  boolean(): boolean {
    this.i++;
    const c = this.s[this.i++];
    if (c === '1') return true;
    if (c === '0') return false;
    throw new SyntaxError('boolean');
  }
  number(): number {
    const m = /^-?\d{1,15}(\.\d{1,3})?/.exec(this.s.slice(this.i));
    if (!m) throw new SyntaxError('number');
    this.i += m[0].length;
    return Number(m[0]);
  }
  token(): { token: string } {
    const m = /^[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*/.exec(this.s.slice(this.i));
    if (!m) throw new SyntaxError('token');
    this.i += m[0].length;
    return { token: m[0] };
  }
  params(): Params {
    const out: Params = {};
    while (this.peek() === ';') {
      this.i++;
      this.skipSp();
      const k = this.key();
      let v: BareItem = true;
      if (this.peek() === '=') {
        this.i++;
        v = this.bare();
      }
      out[k] = v;
    }
    return out;
  }
  item(): Item {
    const value = this.bare();
    return { value, params: this.params() };
  }
  innerList(): InnerList {
    this.i++;
    const items: Item[] = [];
    for (;;) {
      this.skipSp();
      if (this.peek() === ')') {
        this.i++;
        return { items, params: this.params() };
      }
      items.push(this.item());
      const c = this.peek();
      if (c !== ' ' && c !== ')') throw new SyntaxError('inner list');
    }
  }
  member(): Member {
    return this.peek() === '(' ? this.innerList() : this.item();
  }
}

/** Parses a Dictionary field value, or returns null if it is not one. */
export function parseDictionary(value: string | null | undefined): Dictionary | null {
  if (value == null) return null;
  const p = new Parser(value.trim());
  const out: Dictionary = new Map();
  try {
    while (!p.done()) {
      const k = p.key();
      let m: Member;
      if (p.peek() === '=') {
        p.i++;
        m = p.member();
      } else m = { value: true, params: p.params() };
      out.set(k, m);
      p.skipOws();
      if (p.done()) break;
      if (p.s[p.i++] !== ',') return null;
      p.skipOws();
      if (p.done()) return null;
    }
    return out;
  } catch {
    return null;
  }
}

const serializeBare = (v: BareItem): string => {
  if (typeof v === 'string') return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (typeof v === 'boolean') return v ? '?1' : '?0';
  if (typeof v === 'number') return String(v);
  if (v instanceof Uint8Array) return `:${btoa(String.fromCharCode(...v))}:`;
  return v.token;
};

export function serializeParams(params: Params): string {
  return Object.entries(params)
    .map(([k, v]) => (v === true ? `;${k}` : `;${k}=${serializeBare(v)}`))
    .join('');
}

export const serializeItem = (item: Item) =>
  serializeBare(item.value) + serializeParams(item.params);

export const serializeInnerList = (list: InnerList) =>
  `(${list.items.map(serializeItem).join(' ')})${serializeParams(list.params)}`;

export function serializeDictionary(dict: Dictionary): string {
  return [...dict]
    .map(([k, m]) =>
      isInnerList(m)
        ? `${k}=${serializeInnerList(m)}`
        : m.value === true
          ? `${k}${serializeParams(m.params)}`
          : `${k}=${serializeItem(m)}`,
    )
    .join(', ');
}
