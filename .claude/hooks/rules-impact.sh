#!/bin/bash
# PostToolUse (Edit|Write|MultiEdit): when the edited file is covered by a row in the rules map
# (.claude/skills/orderloop-conventions/references/rules-map.tsv), tells Claude the rule an edit
# there has to keep. Advisory, and said once per file per session so an edit loop isn't nagged.
# The docs side of the same edit is docs-impact.sh's job.
. "$(dirname "$0")/lib.sh"
file=$(field .tool_input.file_path)
[ -z "$file" ] && exit 0
loc=$(repo_path "$file") || exit 0
rel=${loc#*$'\t'}
map="$(cd "$(dirname "$0")/.." && pwd)/skills/orderloop-conventions/references/rules-map.tsv"
[ -r "$map" ] || exit 0

rules=""
while IFS=$'\t' read -r re rule; do
  case "$re" in '#'* | '') continue ;; esac
  printf '%s\n' "$rel" | grep -qE -- "$re" && rules+="- $rule"$'\n'
done <"$map"
[ -z "$rules" ] && exit 0
once rules "$loc" || exit 0
context PostToolUse "Rules for $rel:
${rules%$'\n'}"
