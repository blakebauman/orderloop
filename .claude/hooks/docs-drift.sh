#!/bin/bash
# Stop: if this session edited a documented surface (see the surface map) that is still
# uncommitted, and edited nothing under apps/docs/ or README.md in the same tree, block once per
# drift-set per session and ask for a docs sync or an explicit "no docs change needed".
#
# "This session edited" comes from the edit log docs-impact.sh keeps. Files changed by another
# session, or by hand, are not counted, so two sessions sharing a checkout don't trip each other.
# Edits made through Bash (sed, heredocs) never reach the log, so they aren't counted either: the
# hook fails open. Never loops: a second stop goes through.
input=$(cat)
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0

sid=$(printf '%s' "$input" | jq -r '.session_id // "nosession"')
log="${TMPDIR:-/tmp}/orderloop-docs-edits-$sid"
[ -s "$log" ] || exit 0
map="$(dirname "$0")/docs-map.sh"

all_hits=""
for top in $(cut -f1 "$log" | sort -u); do
  ours=$(awk -F'\t' -v t="$top" '$1 == t { print $2 }' "$log" | sort -u)
  # Any docs-side edit in this tree counts as "docs were considered".
  printf '%s\n' "$ours" | grep -qE '^(apps/docs/(src|astro\.config\.mjs)|README\.md$)' && continue
  changed=$({ git -C "$top" diff --name-only HEAD 2>/dev/null; git -C "$top" ls-files --others --exclude-standard 2>/dev/null; } | sort -u)
  [ -z "$changed" ] && continue
  pending=$(comm -12 <(printf '%s\n' "$ours") <(printf '%s\n' "$changed"))
  [ -z "$pending" ] && continue
  hits=$(printf '%s\n' "$pending" | "$map")
  [ -n "$hits" ] && all_hits+="$hits"$'\n'
done
all_hits=$(printf '%s' "$all_hits" | sed '/^$/d')
[ -z "$all_hits" ] && exit 0

state="${TMPDIR:-/tmp}/orderloop-docs-drift-$sid"
hash=$(printf '%s\n' "$all_hits" | cut -f1 | sort -u | shasum | cut -c1-12)
grep -qs "$hash" "$state" && exit 0
echo "$hash" >>"$state"

files=$(printf '%s\n' "$all_hits" | cut -f1 | sort -u | head -6 | tr '\n' ' ' | sed 's/ $//')
pages=$(printf '%s\n' "$all_hits" | cut -f2 | tr ' ' '\n' | sort -u | head -10 | tr '\n' ' ')
reason="Docs check: this session changed documented surfaces ($files) but no docs. Pages to check: $pages(relative to apps/docs/src/content/). Run the docs-sync skill or delegate to the docs-sync agent, or state plainly why no documentation change is needed. Fires once per drift-set per session."
jq -cn --arg r "$reason" '{decision:"block", reason:$r}'
exit 0
