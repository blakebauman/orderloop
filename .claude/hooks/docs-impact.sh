#!/bin/bash
# PostToolUse (Edit|Write|MultiEdit): when an edited file is a documented surface, name the docs
# pages that describe it. Advisory only; silent for anything the surface map doesn't cover, and
# says it once per file per session so a long edit loop isn't nagged on every save.
input=$(cat)
file=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file" ] && exit 0
root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
rel="${file#"$root"/}"
[ "$rel" = "$file" ] && exit 0 # outside the project

hits=$(printf '%s\n' "$rel" | "$(dirname "$0")/docs-map.sh")
[ -z "$hits" ] && exit 0

sid=$(printf '%s' "$input" | jq -r '.session_id // "nosession"')
seen="${TMPDIR:-/tmp}/orderloop-docs-impact-$sid"
grep -qxF "$rel" "$seen" 2>/dev/null && exit 0
echo "$rel" >>"$seen"

pages=$(printf '%s\n' "$hits" | cut -f2 | tr ' ' '\n' | sort -u | sed 's#^\([a-z]*/[a-z-]*\)$#apps/docs/src/content/\1.mdx#' | tr '\n' ' ' | sed 's/ $//')
gen=""
printf '%s\n' "$hits" | cut -f3 | grep -qx gen && gen=" A reference page renders from this file at build time: run \`pnpm docs:build\`, then check the prose around it."
msg="Docs: $rel is described in $pages.$gen Sync them before you finish (docs-sync skill), or say why no change is needed."
jq -cn --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse", additionalContext:$m}}'
exit 0
