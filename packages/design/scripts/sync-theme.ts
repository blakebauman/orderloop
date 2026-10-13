/**
 * Regenerates the docs' Starlight theme from the Ledger tokens:
 *
 *   pnpm sync:theme
 *
 * apps/docs/src/styles/theme.css is checked in (Starlight loads it through `customCss`) but
 * generated. tests/tokens.test.ts fails when it is stale, and a PreToolUse hook blocks hand edits.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { starlightThemeCss } from '../src/tokens';

const out = fileURLToPath(new URL('../../../apps/docs/src/styles/theme.css', import.meta.url));
const css = starlightThemeCss();
writeFileSync(out, css);
console.log(`wrote ${out} (${css.split('\n').length} lines)`);
