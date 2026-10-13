// Fails the build on a broken internal link or anchor in dist/. Starlight checks sidebar slugs but
// not links in prose, and these pages link into each other by heading (and into the generated node
// catalog by node type), so a renamed heading or node type would otherwise 404 silently.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = new URL('../dist/', import.meta.url).pathname;

function* htmlFiles(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* htmlFiles(p);
    else if (name.endsWith('.html')) yield p;
  }
}

const pages = new Map();
for (const file of htmlFiles(dist)) {
  const html = readFileSync(file, 'utf8');
  const route = `/${relative(dist, file)}`.replace(/index\.html$/, '').replace(/\.html$/, '/');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  pages.set(route, { html, ids });
}

const decode = (s) => decodeURIComponent(s.replace(/&amp;/g, '&'));
const problems = [];
for (const [route, { html }] of pages) {
  for (const [, href] of html.matchAll(/\shref="([^"]+)"/g)) {
    if (!href.startsWith('/') && !href.startsWith('#')) continue;
    if (href.startsWith('//')) continue;
    const [path, frag] = href.split('#');
    let target = path || route;
    // Static files Starlight and Astro emit (assets, sitemap, favicons) are not pages.
    if (/\.[a-z0-9]+$/i.test(target)) continue;
    if (!target.endsWith('/')) target += '/';
    const page = pages.get(target);
    if (!page) problems.push(`${route}: ${href} → no page ${target}`);
    else if (frag && frag !== '_top' && !page.ids.has(decode(frag)))
      problems.push(`${route}: ${href} → no #${frag} on ${target}`);
  }
}

if (problems.length) {
  console.error(`check-links: ${problems.length} broken internal link(s)`);
  for (const p of [...new Set(problems)]) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-links: ${pages.size} pages, every internal link resolves`);
