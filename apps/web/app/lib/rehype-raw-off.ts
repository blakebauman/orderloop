/**
 * What Streamdown's `rehype-raw` import resolves to in a build (`vite.config.ts`). Streamdown lists
 * it among its default plugins, which put all of parse5, about 35 kB gzipped, in the assistant's
 * panel to parse raw HTML in a reply; the assistant's replies are Markdown and never need it. With
 * it gone, raw HTML in a reply is dropped by Streamdown's sanitizer instead of parsed.
 *
 * An attacher that returns no transformer is a no-op to unified.
 */
export default function rehypeRawOff(): void {}
