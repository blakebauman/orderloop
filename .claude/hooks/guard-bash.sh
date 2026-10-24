#!/bin/bash
# PreToolUse (Bash): production changes only come from CI, so a command that would deploy, roll
# back, migrate a remote D1 or delete a Cloudflare resource by hand is denied. Commands that are
# sometimes right but hard to undo (pushing to main, force pushes, merging a PR, remote D1 queries,
# Worker secrets, provisioning a deployment) ask first. Everything else is allowed.
#
# The command is split on ; & | and newlines, so a deploy chained after something harmless is still
# caught. The split ignores quoting, so a quoted "; wrangler deploy" inside an echo also matches:
# that errs toward asking, which is the safe side. Fails open on anything unexpected.
. "$(dirname "$0")/lib.sh"
cmd=$(field .tool_input.command)
[ -z "$cmd" ] && exit 0
cwd=$(field .cwd)

ci="Production deploys from CI: merging to main runs .github/workflows/ci.yml, which migrates D1 and deploys every Worker in ring order, and rolls back on a failed smoke test. Don't do it by hand. If a deploy job failed, re-run its failed jobs (\`gh run rerun <run-id> --failed\`); see the ci-triage skill."

S='[[:space:]]'
while IFS= read -r seg; do
  seg=$(printf '%s' "$seg" | tr -s '[:space:]' ' ' | sed 's/^ //; s/ $//')
  [ -z "$seg" ] && continue
  m() { printf '%s\n' "$seg" | grep -qE -- "$1"; }

  # ── Deny: these only ever happen in CI ─────────────────────────────────────
  m "(^|$S|/)wrangler$S+(deploy|versions$S+deploy|rollback|delete)($S|$)" &&
    deny PreToolUse "Blocked \`$seg\`. $ci"
  m "(^|$S|/)wrangler$S+d1$S+migrations$S+apply($S.*)?$S--remote($S|=|$)" &&
    deny PreToolUse "Blocked \`$seg\`. Remote D1 migrations run in CI before the Workers deploy, and a failed smoke test rolls the Workers back but not D1. Apply locally with \`pnpm db:migrate:local\`. $ci"
  m "(^|$S|/)wrangler$S+d1$S+time-travel$S+restore($S|$)" &&
    deny PreToolUse "Blocked \`$seg\`: a Time Travel restore replaces the whole production database and loses every write since the bookmark. It's an incident decision for the user (docs/deploy.md, \"Restoring D1\"); give them the command instead."
  m "(^|$S|/)wrangler$S+(d1|kv$S+namespace|r2$S+bucket|queues)$S+delete($S|$)" &&
    deny PreToolUse "Blocked \`$seg\`: deleting a deployment's Cloudflare resource strands its data. Removing a customer is a reviewed procedure (docs/operations.md, \"Removing a customer\"); ask the user to run it."
  if m "^(pnpm|npm|yarn|bun|turbo|npx$S+turbo)($S|$)"; then
    m "($S)(run$S+)?(docs:)?deploy($S|$)" && deny PreToolUse "Blocked \`$seg\`. $ci"
    m "($S)(run$S+)?db:migrate:remote($S|$)" &&
      deny PreToolUse "Blocked \`$seg\`. Remote D1 migrations run in CI before the Workers deploy. Apply locally with \`pnpm db:migrate:local\`. $ci"
  fi

  # ── Ask: sometimes right, hard to undo ─────────────────────────────────────
  m "(^|$S|/)wrangler$S+d1$S+execute($S.*)?$S--remote($S|=|$)" &&
    ask PreToolUse "\`$seg\` runs SQL against a production D1. Reads are fine with the user's go-ahead; schema or data changes belong in a numbered migration that CI applies."
  m "(^|$S|/)wrangler$S+secret$S+(put|delete|bulk)($S|$)" &&
    ask PreToolUse "\`$seg\` changes a deployed Worker's secret. CI sets PRINCIPAL_KEY and DATA_KEY from the GitHub environment on every deploy; rotating them follows docs/operations.md."
  m "(^|$S|/)scripts/provision\.sh($S|$)" &&
    ask PreToolUse "\`$seg\` creates Cloudflare resources and a GitHub environment for a deployment. Run it only for a deployment the user named."
  m "^gh$S+pr$S+merge($S|$)" &&
    ask PreToolUse "Merging to main deploys to every deployment in ring order. Confirm with the user before merging."
  m "^gh$S+workflow$S+run($S|$)" &&
    ask PreToolUse "\`$seg\` starts a workflow run by hand. To recover a failed deploy, re-run its failed jobs instead."
  if m "^git$S+push($S|$)"; then
    m "$S(-f|--force|--force-with-lease(=[^ ]*)?|--mirror|--delete|-d)($S|$)|$S\+[^ ]+" &&
      ask PreToolUse "\`$seg\` rewrites or deletes remote history. Confirm with the user first."
    m "$S([^ ]*:)?(refs/heads/)?main($S|$)" &&
      ask PreToolUse "\`$seg\` pushes to main, which deploys to production. Push a branch and open a PR instead."
    # On main, a push that names no refspec (or names HEAD) pushes main.
    branch=$(git -C "${cwd:-.}" branch --show-current 2>/dev/null)
    if [ "$branch" = main ]; then
      args=$(printf '%s\n' "${seg#git push}" | tr ' ' '\n' | grep -v '^-' | grep -c .)
      { [ "$args" -lt 2 ] || m "${S}HEAD($S|$)"; } &&
        ask PreToolUse "\`$seg\` runs on main, so it would push main, which deploys to production. Work on a branch in a worktree and open a PR."
    fi
  fi
done < <(printf '%s\n' "$cmd" | tr ';&|' '\n\n\n')
exit 0
