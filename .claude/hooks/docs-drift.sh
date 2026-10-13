#!/bin/bash
# Stop: if the working tree changes a documented surface (see the surface map) and nothing under
# apps/docs/ or README.md changed with it, block once per drift-set per session and ask for a docs
# sync or an explicit "no docs change needed". Never loops: a second stop goes through.
input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
changed=$({ git diff --name-only HEAD 2>/dev/null; git ls-files --others --exclude-standard 2>/dev/null; } | sort -u)
[ -z "$changed" ] && exit 0

# Any docs-side change counts as "docs were considered".
printf '%s\n' "$changed" | grep -qE '^(apps/docs/(src|astro\.config\.mjs)|README\.md$)' && exit 0

hits=$(printf '%s\n' "$changed" | "$(dirname "$0")/docs-map.sh")
[ -z "$hits" ] && exit 0

sid=$(printf '%s' "$input" | jq -r '.session_id // "nosession"')
state="${TMPDIR:-/tmp}/orderloop-docs-drift-$sid"
hash=$(printf '%s\n' "$hits" | cut -f1 | sort -u | shasum | cut -c1-12)
grep -qs "$hash" "$state" && exit 0
echo "$hash" >>"$state"

files=$(printf '%s\n' "$hits" | cut -f1 | sort -u | head -6 | tr '\n' ' ' | sed 's/ $//')
pages=$(printf '%s\n' "$hits" | cut -f2 | tr ' ' '\n' | sort -u | head -10 | tr '\n' ' ')
reason="Docs check: this working tree changes documented surfaces ($files) but nothing under apps/docs/ changed. Pages to check: $pages(relative to apps/docs/src/content/). Run the docs-sync skill or delegate to the docs-sync agent, or state plainly why no documentation change is needed. Fires once per drift-set per session."
jq -cn --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
