#!/bin/bash
# Lints the Claude Code toolkit itself, so a typo fails here instead of silently disabling a skill,
# an agent or a hook (Claude Code ignores unknown frontmatter and a missing hook script quietly).
# Run from anywhere: .claude/scripts/toolkit-check.sh. Checks:
#   - skills: Agent Skills spec (name = directory, lowercase-hyphen, ≤64 chars; a description
#     ≤1024 chars), SKILL.md under 500 lines, every linked references/ file exists
#   - agents: name = file name, a description, every preloaded skill exists and can be preloaded
#   - settings.json: every hook command is an executable script that parses (bash -n)
#   - the rules and surface maps: two columns where expected, and every regex compiles
set -u
command -v jq >/dev/null 2>&1 || { echo "FAIL jq is not installed: the hooks need it (and do nothing without it). Install it (brew install jq) and re-run."; exit 1; }
root=$(cd "$(dirname "$0")/../.." && pwd)
kit="$root/.claude"
fail=0
bad() { echo "FAIL $*"; fail=1; }

# frontmatter <file>: the YAML between the first two --- lines.
frontmatter() { awk 'NR==1 && $0!="---" {exit} NR>1 && $0=="---" {exit} NR>1 {print}' "$1"; }
key() { frontmatter "$1" | sed -n "s/^$2: *//p" | head -1 | sed -E 's/^"(.*)"$/\1/'; }

# ── Skills ────────────────────────────────────────────────────────────────────
for dir in "$kit"/skills/*/; do
  dir=${dir%/}
  id=$(basename "$dir")
  f="$dir/SKILL.md"
  [ -f "$f" ] || { bad "skill $id: no SKILL.md"; continue; }
  name=$(key "$f" name)
  desc=$(key "$f" description)
  [ "$name" = "$id" ] || bad "skill $id: name '$name' doesn't match its directory"
  printf '%s' "$name" | grep -qE '^[a-z0-9]+(-[a-z0-9]+)*$' || bad "skill $id: name must be lowercase letters, digits and single hyphens"
  [ "${#name}" -le 64 ] || bad "skill $id: name over 64 characters"
  [ -n "$desc" ] || bad "skill $id: no description"
  [ "${#desc}" -le 1024 ] || bad "skill $id: description is ${#desc} characters (max 1024)"
  lines=$(wc -l <"$f")
  [ "$lines" -lt 500 ] || bad "skill $id: SKILL.md is $lines lines; move detail into references/"
  for ref in $(grep -oE '\]\((references|scripts)/[^)#]+' "$f" | sed 's/^](//'); do
    [ -e "$dir/$ref" ] || bad "skill $id: links to missing $ref"
  done
done

# ── Agents ────────────────────────────────────────────────────────────────────
for f in "$kit"/agents/*.md; do
  id=$(basename "$f" .md)
  [ "$(key "$f" name)" = "$id" ] || bad "agent $id: name doesn't match its file name"
  [ -n "$(key "$f" description)" ] || bad "agent $id: no description"
  for s in $(frontmatter "$f" | awk '/^skills:/ {on=1; next} on && /^  - / {print $2; next} {on=0}'); do
    sf="$kit/skills/$s/SKILL.md"
    if [ ! -f "$sf" ]; then
      bad "agent $id: preloads missing skill '$s'"
    elif [ "$(key "$sf" disable-model-invocation)" = true ]; then
      bad "agent $id: preloads '$s', which has disable-model-invocation (it can't be preloaded)"
    fi
  done
done

# ── Hooks wired in settings.json ──────────────────────────────────────────────
settings="$kit/settings.json"
if ! jq empty "$settings" 2>/dev/null; then
  bad "settings.json doesn't parse"
else
  jq -r '.hooks[][] .hooks[] | select(.type == "command") | .command' "$settings" | sort -u |
    while IFS= read -r cmd; do
      script=$(printf '%s' "$cmd" | sed -E 's/^"?\$CLAUDE_PROJECT_DIR\/?//; s/"$//; s/^"//')
      path="$root/$script"
      if [ ! -x "$path" ]; then echo "FAIL hook '$cmd': $script is missing or not executable"; exit 1; fi
      bash -n "$path" 2>/dev/null || { echo "FAIL hook $script: syntax error"; exit 1; }
    done || fail=1
fi

# ── Maps ──────────────────────────────────────────────────────────────────────
check_map() { # file, expected columns
  local n=0 re
  while IFS= read -r line; do
    n=$((n + 1))
    case "$line" in '#'* | '') continue ;; esac
    [ "$(printf '%s' "$line" | awk -F'\t' '{print NF}')" -ge "$2" ] || bad "$(basename "$1"):$n: fewer than $2 tab-separated columns"
    re=${line%%$'\t'*}
    grep -qE -- "$re" </dev/null 2>/dev/null
    [ $? -eq 2 ] && bad "$(basename "$1"):$n: regex doesn't compile: $re"
  done <"$1"
}
check_map "$kit/skills/orderloop-conventions/references/rules-map.tsv" 2
check_map "$kit/skills/docs-sync/references/surface-map.tsv" 2

[ $fail -eq 0 ] && echo "ok   toolkit: skills, agents, hooks and maps"
exit $fail
