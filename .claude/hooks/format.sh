#!/bin/bash
# PostToolUse (Edit|Write|MultiEdit): runs Biome on the one file just edited, with safe fixes
# (format, import order), so `pnpm lint` in CI never fails on style Claude could have fixed. Silent
# when the file comes out clean; when Biome leaves errors it can't fix, they go back to Claude as
# context. Files Biome ignores (biome.json, .gitignore) are skipped. Fails open.
. "$(dirname "$0")/lib.sh"
file=$(field .tool_input.file_path)
case "$file" in *.ts | *.tsx | *.js | *.mjs | *.cjs | *.jsx | *.json | *.jsonc | *.css) ;; *) exit 0 ;; esac
[ -f "$file" ] || exit 0
loc=$(repo_path "$file") || exit 0
top=${loc%%$'\t'*}
biome="$top/node_modules/.bin/biome"
[ -x "$biome" ] || exit 0

out=$(cd "$top" && "$biome" check --write --no-errors-on-unmatched --files-ignore-unknown=true --colors=off "$file" 2>&1) && exit 0
context PostToolUse "Biome left errors in ${loc#*$'\t'} that it can't fix on its own (\`pnpm lint\` will fail on them):
$(printf '%s\n' "$out" | head -40)"
