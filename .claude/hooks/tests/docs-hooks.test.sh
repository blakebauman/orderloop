#!/bin/bash
# Pipes realistic hook input into the docs hooks and checks what they say. Run from the repo root:
#   .claude/hooks/tests/docs-hooks.test.sh
# The Stop-hook cases run against a throwaway git repo, so they never read this checkout's state.
set -u
root=$(cd "$(dirname "$0")/../../.." && pwd)
hooks="$root/.claude/hooks"
export TMPDIR=$(mktemp -d)
fail=0
check() { # name, expected substring ('' = expect silence), actual
  if [ -z "$2" ]; then
    [ -z "$3" ] && echo "ok   $1" || { echo "FAIL $1: expected silence, got: $3"; fail=1; }
  else
    case "$3" in *"$2"*) echo "ok   $1" ;; *) echo "FAIL $1: expected '$2', got: $3"; fail=1 ;; esac
  fi
}
edit() { printf '{"session_id":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2" | "$hooks/docs-impact.sh"; }
stop() { printf '{"session_id":"%s"}' "$1" | "$hooks/docs-drift.sh"; }

# ── docs-impact: naming pages ────────────────────────────────────────────────
check "catalog edit names the node catalog" "reference/nodes.mdx" "$(edit s1 "$root/packages/core/src/catalog.ts")"
check "catalog edit says it is generated" "renders from this file" "$(edit s2 "$root/packages/core/src/catalog.ts")"
check "second edit of the same file is quiet" "" "$(edit s2 "$root/packages/core/src/catalog.ts")"
check "app.css edit names brand.css" "apps/docs/src/styles/brand.css" "$(edit s3 "$root/apps/web/app/app.css")"
check "undocumented file is quiet" "" "$(edit s5 "$root/packages/ui/src/button.tsx")"
check "file outside any repo is quiet" "" "$(edit s6 /etc/hosts)"
check "map lookup is exact" "" "$(printf 'packages/core/src/catalog.tsx\n' | "$hooks/docs-map.sh")"

check "templates edit names the home page" "apps/docs/src/content/index.mdx" "$(edit s7 "$root/packages/core/src/templates.ts")"
check "app.css edit names the design tokens" "packages/design/src/tokens.ts" "$(edit s8 "$root/apps/web/app/app.css")"

# ── block-generated: generated files are denied, everything else allowed ─────
guard() { printf '{"tool_input":{"file_path":"%s"}}' "$1" | "$hooks/block-generated.sh"; }
check "hand edit of the generated docs theme is denied" '"permissionDecision":"deny"' "$(guard "$root/apps/docs/src/styles/theme.css")"
check "wrangler-generated types are denied" '"permissionDecision":"deny"' "$(guard "$root/apps/web/worker-configuration.d.ts")"
check "hand-written docs styles are allowed" "" "$(guard "$root/apps/docs/src/styles/brand.css")"

# ── docs-drift: only this session's uncommitted edits count ───────────────────
repo="$TMPDIR/repo"
mkdir -p "$repo/packages/core/src" "$repo/packages/db/src" "$repo/apps/docs/src/content"
git -C "$repo" init -q
echo a >"$repo/packages/core/src/catalog.ts"
echo a >"$repo/packages/db/src/schema.ts"
echo a >"$repo/apps/docs/src/content/page.mdx"
git -C "$repo" add -A && git -C "$repo" -c user.email=t@t -c user.name=t commit -qm init
commit() { git -C "$1" -c user.email=t@t -c user.name=t commit -qam "$2"; }

check "stop hook never loops" "" "$(printf '{"stop_hook_active":true}' | "$hooks/docs-drift.sh")"

echo b >>"$repo/packages/db/src/schema.ts" # another session's change: never in our log
check "another session's change is not ours" "" "$(stop d1)"

edit d2 "$repo/packages/core/src/catalog.ts" >/dev/null
echo b >>"$repo/packages/core/src/catalog.ts"
out=$(stop d2)
check "own uncommitted surface edit blocks" '"decision":"block"' "$out"
check "block names only our file" "" "$(printf '%s' "$out" | grep -o 'schema.ts')"
check "same drift-set blocks once" "" "$(stop d2)"

edit d3 "$repo/packages/core/src/catalog.ts" >/dev/null
edit d3 "$repo/apps/docs/src/content/page.mdx" >/dev/null
check "a docs edit in the same tree satisfies it" "" "$(stop d3)"

commit "$repo" "land it"
edit d4 "$repo/packages/core/src/catalog.ts" >/dev/null
check "a committed edit no longer blocks" "" "$(stop d4)"

git -C "$repo" worktree add -q "$TMPDIR/wt" -b wt 2>/dev/null
edit d5 "$TMPDIR/wt/packages/db/src/schema.ts" >/dev/null
echo c >>"$TMPDIR/wt/packages/db/src/schema.ts"
check "an edit inside a worktree counts against that worktree" "packages/db/src/schema.ts" "$(stop d5)"

rm -rf "$TMPDIR"
exit $fail
