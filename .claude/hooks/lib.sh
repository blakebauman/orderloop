#!/bin/bash
# Shared by the guard and rules hooks (sourced, not run). Reads the hook input once into $input and
# gives each hook the same small vocabulary for answering Claude Code. Every hook that sources this
# still fails open: a missing jq or an unexpected input shape ends in silence, never a block.
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0

# field <jq path>: one value from the hook input, empty when absent.
field() { printf '%s' "$input" | jq -r "$1 // empty" 2>/dev/null; }

sid=$(field .session_id)
sid=${sid:-nosession}

# deny|ask <event> <reason>: a PreToolUse permission decision, then exit.
deny() { jq -cn --arg e "$1" --arg r "$2" '{hookSpecificOutput:{hookEventName:$e, permissionDecision:"deny", permissionDecisionReason:$r}}'; exit 0; }
ask() { jq -cn --arg e "$1" --arg r "$2" '{hookSpecificOutput:{hookEventName:$e, permissionDecision:"ask", permissionDecisionReason:$r}}'; exit 0; }

# context <event> <text>: advisory text added to Claude's context, then exit.
context() { jq -cn --arg e "$1" --arg m "$2" '{hookSpecificOutput:{hookEventName:$e, additionalContext:$m}}'; exit 0; }

# once <name> <key>: true the first time this session sees key under name, false after.
once() {
  local state="${TMPDIR:-/tmp}/orderloop-$1-$sid"
  grep -qxF -- "$2" "$state" 2>/dev/null && return 1
  printf '%s\n' "$2" >>"$state"
}

# repo_path <file>: "<git root>\t<path relative to it>" for a file inside a git tree. Resolves
# symlinks first, since git reports the physical toplevel (/private/var/… for /var/… on macOS).
repo_path() {
  local dir top
  dir=$(cd "$(dirname "$1")" 2>/dev/null && pwd -P) || return 1
  top=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || return 1
  printf '%s\t%s\n' "$top" "${dir#"$top"}/$(basename "$1")" | sed 's#\t/#\t#'
}
