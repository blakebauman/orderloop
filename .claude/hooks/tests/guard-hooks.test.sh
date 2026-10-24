#!/bin/bash
# Pipes realistic hook input into the guard, format, rules and session hooks and checks what they
# say. Run from the repo root:
#   .claude/hooks/tests/guard-hooks.test.sh
# Cases that depend on git state (an applied migration, being on main) run against a throwaway
# repo with its own origin, so they never read this checkout's branch or history.
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
DENY='"permissionDecision":"deny"'
ASK='"permissionDecision":"ask"'

# A throwaway repo on a feature branch, with origin/main holding one applied migration.
repo="$TMPDIR/repo"
mkdir -p "$repo/packages/db/migrations" "$repo/plugins/acme/migrations"
git -C "$repo" init -q -b main
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
echo 'CREATE TABLE a (id TEXT);' >"$repo/packages/db/migrations/0001_init.sql"
echo 'CREATE TABLE p (id TEXT);' >"$repo/plugins/acme/migrations/0001_init.sql"
git -C "$repo" add -A && git -C "$repo" -c user.email=t@t -c user.name=t commit -q -m applied
git -C "$repo" update-ref refs/remotes/origin/main HEAD
git -C "$repo" checkout -q -b feat/x

# ── guard-bash: deploys denied, risky things asked, the rest silent ───────────
bash_in() { jq -cn --arg c "$1" --arg d "${2:-$repo}" '{session_id:"g",cwd:$d,tool_input:{command:$c}}' | "$hooks/guard-bash.sh"; }
check "pnpm deploy is denied" "$DENY" "$(bash_in 'pnpm deploy')"
check "a workspace deploy script is denied" "$DENY" "$(bash_in 'pnpm --filter @orderloop/engine run deploy')"
check "the docs deploy is denied" "$DENY" "$(bash_in 'pnpm docs:deploy')"
check "wrangler deploy chained after a test is denied" "$DENY" "$(bash_in 'pnpm test && pnpm --filter @orderloop/web exec wrangler deploy')"
check "npx wrangler versions deploy is denied" "$DENY" "$(bash_in 'npx wrangler versions deploy')"
check "wrangler rollback is denied" "$DENY" "$(bash_in 'wrangler rollback -y')"
check "remote migrations are denied" "$DENY" "$(bash_in 'wrangler d1 migrations apply orderloop --remote')"
check "the remote migrate script is denied" "$DENY" "$(bash_in 'pnpm --filter @orderloop/web db:migrate:remote')"
check "a Time Travel restore is denied" "$DENY" "$(bash_in 'wrangler d1 time-travel restore orderloop --bookmark=x')"
check "deleting a queue is denied" "$DENY" "$(bash_in 'wrangler queues delete orderloop-catalog-purge')"
check "remote D1 SQL asks" "$ASK" "$(bash_in "wrangler d1 execute orderloop --remote --command 'select 1'")"
check "a Worker secret asks" "$ASK" "$(bash_in 'echo x | wrangler secret put DATA_KEY')"
check "provisioning asks" "$ASK" "$(bash_in './scripts/provision.sh acme')"
check "merging a PR asks" "$ASK" "$(bash_in 'gh pr merge 151 --squash')"
check "pushing main asks" "$ASK" "$(bash_in 'git push origin main')"
check "pushing HEAD:main asks" "$ASK" "$(bash_in 'git push origin HEAD:main')"
check "a force push asks" "$ASK" "$(bash_in 'git push --force origin feat/x')"
check "a +refspec push asks" "$ASK" "$(bash_in 'git push origin +feat/x')"
check "pushing a feature branch is allowed" "" "$(bash_in 'git push -u origin feat/x')"
check "local migrations are allowed" "" "$(bash_in 'wrangler d1 migrations apply orderloop --local')"
check "wrangler dev is allowed" "" "$(bash_in 'pnpm --filter @orderloop/engine exec wrangler dev')"
check "wrangler types is allowed" "" "$(bash_in 'pnpm --filter @orderloop/engine types')"
check "a test named deploy is allowed" "" "$(bash_in 'pnpm test -- deploy.test.ts')"
check "re-running failed jobs is allowed" "" "$(bash_in 'gh run rerun 123 --failed')"
git -C "$repo" checkout -q main
check "a bare push on main asks" "$ASK" "$(bash_in 'git push')"
check "pushing another branch from main is allowed" "" "$(bash_in 'git push origin feat/x')"
git -C "$repo" checkout -q feat/x
check "a bare push on a branch is allowed" "" "$(bash_in 'git push')"

# ── guard-invariants: applied migrations, vendored fixtures, z routes ─────────
edit_in() { jq -cn --arg f "$1" --arg t "${2:-x}" '{session_id:"g",tool_input:{file_path:$f,new_string:$t}}' | "$hooks/guard-invariants.sh"; }
write_in() { jq -cn --arg f "$1" --arg t "$2" '{session_id:"g",tool_input:{file_path:$f,content:$t}}' | "$hooks/guard-invariants.sh"; }
check "an applied migration is denied" "$DENY" "$(edit_in "$repo/packages/db/migrations/0001_init.sql")"
check "an applied plugin migration is denied" "$DENY" "$(edit_in "$repo/plugins/acme/migrations/0001_init.sql")"
check "a new migration is allowed" "" "$(write_in "$repo/packages/db/migrations/0002_next.sql" 'ALTER TABLE a ADD COLUMN b TEXT;')"
check "the vendored UCP schemas are denied" "$DENY" "$(edit_in "$root/packages/core/tests/fixtures/ucp/schemas/x.json")"
check "the routing golden test asks" "$ASK" "$(edit_in "$root/packages/core/tests/product-routing.test.ts")"
check "a /healthz route is denied" "$DENY" "$(edit_in "$root/apps/web/app/routes.ts" "route('/healthz', 'routes/health.ts')")"
check "a /readyz route in a new file is denied" "$DENY" "$(write_in "$root/apps/engine/src/new.ts" "if (url.pathname === '/readyz') {}")"
check "a MultiEdit adding /livez is denied" "$DENY" "$(jq -cn --arg f "$root/apps/web/app/x.ts" '{tool_input:{file_path:$f,edits:[{new_string:"ok"},{new_string:"fetch(\"/livez\")"}]}}' | "$hooks/guard-invariants.sh")"
check "/health is allowed" "" "$(edit_in "$root/apps/web/app/routes.ts" "route('/health', 'routes/health.ts')")"
check "a word ending in z is allowed" "" "$(edit_in "$root/apps/web/app/x.ts" "'/quiz'")"
check "CLAUDE.md may name the rule" "" "$(edit_in "$root/CLAUDE.md" 'not `/healthz`')"

# ── rules-impact: path rules, once per file per session ───────────────────────
rules_in() { jq -cn --arg s "$1" --arg f "$2" '{session_id:$s,tool_input:{file_path:$f}}' | "$hooks/rules-impact.sh"; }
check "catalog.ts names the node-type checklist" "node-icon.tsx" "$(rules_in r1 "$root/packages/core/src/catalog.ts")"
check "catalog.ts also gets the core rule" "no Cloudflare imports" "$(rules_in r2 "$root/packages/core/src/catalog.ts")"
check "a second edit of the same file is quiet" "" "$(rules_in r2 "$root/packages/core/src/catalog.ts")"
check "a wrangler config names fleet.ts" "scripts/fleet.ts" "$(rules_in r3 "$root/apps/engine/wrangler.jsonc")"
check "roles.ts asks for a security review" "security-reviewer" "$(rules_in r4 "$root/packages/core/src/roles.ts")"
check "workflow.ts names step names" '${nodeId}#${run}' "$(rules_in r5 "$root/apps/engine/src/workflow.ts")"
check "an uncovered file is quiet" "" "$(rules_in r6 "$root/apps/web/app/routes/home.tsx")"
check "a file outside any repo is quiet" "" "$(rules_in r7 /etc/hosts)"

# ── format: Biome fixes what it can, reports what it can't ────────────────────
if [ -x "$root/node_modules/.bin/biome" ]; then
  fmt="$root/packages/core/src/__fmt_probe.ts"
  printf 'export const a = {b:1}\n' >"$fmt"
  check "formatting a fixable file is quiet" "" "$(jq -cn --arg f "$fmt" '{tool_input:{file_path:$f}}' | "$hooks/format.sh")"
  check "and the file is formatted" "export const a = { b: 1 };" "$(cat "$fmt")"
  printf 'import { x } from "./nowhere";\nexport const a = 1;\n' >"$fmt"
  check "an unused import is reported" "Biome left errors" "$(jq -cn --arg f "$fmt" '{tool_input:{file_path:$f}}' | "$hooks/format.sh")"
  rm -f "$fmt"
else
  echo "skip format: node_modules/.bin/biome not installed"
fi
check "a non-code file isn't formatted" "" "$(jq -cn --arg f "$root/README.md" '{tool_input:{file_path:$f}}' | "$hooks/format.sh")"

# ── session-context: where am I ───────────────────────────────────────────────
git -C "$repo" checkout -q main
check "main in a plain checkout warns about the shared tree" "git worktree add" "$(echo '{}' | CLAUDE_PROJECT_DIR=$repo "$hooks/session-context.sh")"
git -C "$repo" worktree add -q "$TMPDIR/wt" -b feat/y
check "a worktree on a branch says so" "worktree: yes" "$(echo '{}' | CLAUDE_PROJECT_DIR=$TMPDIR/wt "$hooks/session-context.sh")"
check "and doesn't warn" "" "$(echo '{}' | CLAUDE_PROJECT_DIR=$TMPDIR/wt "$hooks/session-context.sh" | grep -o 'git worktree add')"

rm -rf "$TMPDIR"
exit $fail
