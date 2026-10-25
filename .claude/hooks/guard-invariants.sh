#!/bin/bash
# PreToolUse (Edit|Write|MultiEdit): denies edits that break a rule AGENTS.md states as absolute,
# where the file and the text alone are enough to tell:
#   - a D1 migration that is already on origin/main (applied by CI; add a new numbered one instead)
#   - the vendored UCP schemas in packages/core/tests/fixtures/ucp (kept byte-for-byte)
#   - a z-suffixed endpoint (/healthz, /readyz, …) in new text
# and asks before an edit to the catalog's golden routing test, whose expected values are frozen,
# before an edit to an app's wrangler.jsonc that changes, removes or reorders a Durable Object
# migration already on origin/main or adds a deleted, renamed or transferred class, and before an
# edit to the frozen migration list in scripts/do-migrations.test.ts (which CI enforces).
# Everything else is allowed. block-generated.sh guards generated files separately.
. "$(dirname "$0")/lib.sh"
file=$(field .tool_input.file_path)
[ -z "$file" ] && exit 0
loc=$(repo_path "$file") || exit 0
top=${loc%%$'\t'*}
rel=${loc#*$'\t'}

case "$rel" in
  packages/db/migrations/[0-9][0-9][0-9][0-9]_*.sql | plugins/*/migrations/[0-9][0-9][0-9][0-9]_*.sql)
    base=origin/main
    git -C "$top" rev-parse -q --verify "$base" >/dev/null || base=main
    if git -C "$top" cat-file -e "$base:$rel" 2>/dev/null; then
      deny PreToolUse "$rel is on $base, so CI has applied it to every deployment: editing it changes nothing there and forks local databases from production. Add the next numbered migration instead (d1-migration skill). It must work with the code already deployed: expand now, contract in a later change."
    fi ;;
  packages/core/tests/fixtures/ucp/*)
    deny PreToolUse "packages/core/tests/fixtures/ucp holds UCP's published JSON schemas, vendored unchanged; the tests prove what the engine serves against them. If UCP published a new version, replace the files with the upstream copies in their own change; never hand-edit them to make a test pass." ;;
  packages/core/tests/product-routing.test.ts)
    ask PreToolUse "product-routing.test.ts pins the catalog's shard hash and counts. Its golden values must never change: a different shard for a key strands every stored product. Adding a new case is fine; changing an expected value is not." ;;
  scripts/do-migrations.test.ts)
    ask PreToolUse "do-migrations.test.ts freezes the Durable Object migrations every deployment has applied. Appending a new class's tag (the same entry as in wrangler.jsonc) is fine; changing or removing an entry, or allowing a destructive one, is not without a plan for that class's data." ;;
  apps/*/wrangler.jsonc)
    # The file as it would be after this edit: Write's content, or Edit/MultiEdit applied to it.
    cur=$(cat "$file" 2>/dev/null)
    after=$(printf '%s' "$input" | jq -r --arg cur "$cur" '
      if .tool_input.content != null then .tool_input.content
      else reduce (.tool_input.edits // [.tool_input | {old_string, new_string, replace_all}])[] as $e ($cur;
        if ($e.old_string // "") == "" then .
        elif $e.replace_all then split($e.old_string) | join($e.new_string // "")
        else split($e.old_string) as $p
          | if ($p | length) < 2 then . else $p[0] + ($e.new_string // "") + ($p[1:] | join($e.old_string)) end
        end)
      end' 2>/dev/null) || exit 0
    # The migrations array's entries, one per line, without spacing, commas or comments.
    migrations() {
      awk '/"migrations"[[:space:]]*:/ { on = 1; next } on && /^[[:space:]]*\]/ { exit } on' |
        sed -e 's#//.*##' | tr -d ' \t' | sed -e 's/,$//' | grep -v '^$'
    }
    new=$(printf '%s\n' "$after" | migrations)
    if printf '%s' "$new" | grep -qE '"(deleted|renamed|transferred)_classes"'; then
      ask PreToolUse "This edit adds a deleted, renamed or transferred Durable Object class to $rel. On deploy that destroys or moves every object of the class in every deployment (live order state, carts, catalog shards). Plan the data with the user first; scripts/do-migrations.test.ts refuses it unless allowlisted there."
    fi
    base=origin/main
    git -C "$top" rev-parse -q --verify "$base" >/dev/null || base=main
    old=$(git -C "$top" show "$base:$rel" 2>/dev/null | migrations)
    if [ -n "$old" ]; then
      case "$new"$'\n' in
        "$old"$'\n'*) ;;
        *) ask PreToolUse "This edit changes, removes or reorders a Durable Object migration in $rel that is on $base, so every deployment has applied it. Applied tags stay exactly as they are; a new class gets a new tag appended at the end (and in scripts/do-migrations.test.ts)." ;;
      esac
    fi ;;
esac

# The rule's own statements (AGENTS.md, CLAUDE.md, this toolkit) name the forbidden routes on purpose.
case "$rel" in CLAUDE.md | AGENTS.md | .claude/*) exit 0 ;; esac
text=$(field '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)] | map(select(. != null)) | join("\n")')
hit=$(printf '%s' "$text" | grep -oE '/(healthz|readyz|livez|authz|statusz|varz)\b' | head -1)
[ -n "$hit" ] && deny PreToolUse "Endpoint names never end in a trailing z: use ${hit%z}, not $hit (AGENTS.md)."
exit 0
