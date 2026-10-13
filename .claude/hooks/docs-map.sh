#!/bin/bash
# Shared by docs-impact.sh and docs-drift.sh: reads repo-relative paths on stdin and prints
# "path<TAB>pages<TAB>kind" for each one the surface map covers. The map is
# .claude/skills/docs-sync/references/surface-map.tsv; edit it there, not here.
map="${CLAUDE_PROJECT_DIR:-.}/.claude/skills/docs-sync/references/surface-map.tsv"
[ -r "$map" ] || exit 0
while IFS= read -r path; do
  [ -z "$path" ] && continue
  while IFS=$'\t' read -r re pages kind; do
    case "$re" in '#'* | '') continue ;; esac
    if printf '%s\n' "$path" | grep -qE -- "$re"; then
      printf '%s\t%s\t%s\n' "$path" "$pages" "$kind"
    fi
  done <"$map"
done
exit 0
