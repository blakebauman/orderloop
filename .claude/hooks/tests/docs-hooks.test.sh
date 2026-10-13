#!/bin/bash
# Pipes realistic hook input into the docs hooks and checks what they say. Run from the repo root:
#   .claude/hooks/tests/docs-hooks.test.sh
set -u
root=$(cd "$(dirname "$0")/../../.." && pwd)
export CLAUDE_PROJECT_DIR="$root"
export TMPDIR=$(mktemp -d)
hooks="$root/.claude/hooks"
fail=0
check() { # name, expected substring ('' = expect silence), actual
  if [ -z "$2" ]; then
    [ -z "$3" ] && echo "ok   $1" || { echo "FAIL $1: expected silence, got: $3"; fail=1; }
  else
    case "$3" in *"$2"*) echo "ok   $1" ;; *) echo "FAIL $1: expected '$2', got: $3"; fail=1 ;; esac
  fi
}
edit() { printf '{"session_id":"%s","tool_input":{"file_path":"%s/%s"}}' "$1" "$root" "$2" | "$hooks/docs-impact.sh"; }

check "catalog edit names the node catalog" "reference/nodes.mdx" "$(edit s1 packages/core/src/catalog.ts)"
check "catalog edit says it is generated" "renders from this file" "$(edit s2 packages/core/src/catalog.ts)"
check "second edit of the same file is quiet" "" "$(edit s2 packages/core/src/catalog.ts)"
check "app.css edit names ledger.css" "apps/docs/src/styles/ledger.css" "$(edit s3 apps/web/app/app.css)"
check "migration edit names the data model" "internals/data-model" "$(edit s4 packages/db/migrations/0005_x.sql)"
check "undocumented file is quiet" "" "$(edit s5 packages/ui/src/button.tsx)"
check "file outside the project is quiet" "" "$(printf '{"tool_input":{"file_path":"/etc/hosts"}}' | "$hooks/docs-impact.sh")"
check "map lookup is exact" "" "$(printf 'packages/core/src/catalog.tsx\n' | "$hooks/docs-map.sh")"
check "stop hook never loops" "" "$(printf '{"stop_hook_active":true}' | "$hooks/docs-drift.sh")"

rm -rf "$TMPDIR"
exit $fail
