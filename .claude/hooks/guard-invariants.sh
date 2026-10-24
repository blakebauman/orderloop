#!/bin/bash
# PreToolUse (Edit|Write|MultiEdit): denies edits that break a rule AGENTS.md states as absolute,
# where the file and the text alone are enough to tell:
#   - a D1 migration that is already on origin/main (applied by CI; add a new numbered one instead)
#   - the vendored UCP schemas in packages/core/tests/fixtures/ucp (kept byte-for-byte)
#   - a z-suffixed endpoint (/healthz, /readyz, …) in new text
# and asks before an edit to the catalog's golden routing test, whose expected values are frozen.
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
esac

# The rule's own statements (AGENTS.md, CLAUDE.md, this toolkit) name the forbidden routes on purpose.
case "$rel" in CLAUDE.md | AGENTS.md | .claude/*) exit 0 ;; esac
text=$(field '[.tool_input.content, .tool_input.new_string, (.tool_input.edits // [] | .[].new_string)] | map(select(. != null)) | join("\n")')
hit=$(printf '%s' "$text" | grep -oE '/(healthz|readyz|livez|authz|statusz|varz)\b' | head -1)
[ -n "$hit" ] && deny PreToolUse "Endpoint names never end in a trailing z: use ${hit%z}, not $hit (AGENTS.md)."
exit 0
