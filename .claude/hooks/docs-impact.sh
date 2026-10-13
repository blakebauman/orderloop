#!/bin/bash
# PostToolUse (Edit|Write|MultiEdit). Two jobs:
#   1. Records the edited file in this session's edit log, keyed by the file's own git root, so
#      docs-drift.sh judges only what this session changed. Another session's uncommitted work in
#      the same checkout isn't ours to document, and edits inside a git worktree count against
#      that worktree.
#   2. When the file is a documented surface, names the docs pages that describe it. Advisory, and
#      said once per file per session so a long edit loop isn't nagged on every save.
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file" ] && exit 0
# Resolve symlinks first: git reports the physical toplevel (/private/var/… for /var/… on macOS).
dir=$(cd "$(dirname "$file")" 2>/dev/null && pwd -P) || exit 0
file="$dir/$(basename "$file")"
top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || exit 0
rel="${file#"$top"/}"
[ "$rel" = "$file" ] && exit 0

sid=$(printf '%s' "$input" | jq -r '.session_id // "nosession"')
log="${TMPDIR:-/tmp}/orderloop-docs-edits-$sid"
line=$(printf '%s\t%s' "$top" "$rel")
grep -qxF "$line" "$log" 2>/dev/null && exit 0 # seen this file already: logged and announced
printf '%s\n' "$line" >>"$log"

hits=$(printf '%s\n' "$rel" | "$(dirname "$0")/docs-map.sh")
[ -z "$hits" ] && exit 0

pages=$(printf '%s\n' "$hits" | cut -f2 | tr ' ' '\n' | sort -u | sed -E 's#^([a-z-]+(/[a-z-]+)?)$#apps/docs/src/content/\1.mdx#' | tr '\n' ' ' | sed 's/ $//')
gen=""
printf '%s\n' "$hits" | cut -f3 | grep -qx gen && gen=" A reference page renders from this file at build time: run \`pnpm docs:build\`, then check the prose around it."
msg="Docs: $rel is described in $pages.$gen Sync them before you finish (docs-sync skill), or say why no change is needed."
jq -cn --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$m}}'
exit 0
