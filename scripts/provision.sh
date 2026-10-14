#!/usr/bin/env bash
# Creates the Cloudflare resources and the GitHub environment for one deployment in
# deployments/<id>.jsonc, and records its D1 id there. Safe to re-run: existing resources, and
# secrets already set, are kept. See docs/operations.md.
#
#   ./scripts/provision.sh <id>
#
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) and `gh auth login`. The AI Gateway is created
# through the API, so it also needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID; without them
# it prints what to create instead.
set -euo pipefail
id="${1:?usage: scripts/provision.sh <id>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

eval "$(node scripts/fleet.ts names "$id")"
wrangler() { pnpm --filter @orderloop/engine exec wrangler "$@"; }
j=()
[ -n "$JURISDICTION" ] && j=(--jurisdiction "$JURISDICTION")

echo "== $id: D1 $D1, R2 $R2, gateway $AI_GATEWAY, https://$DOMAIN, environment $ENVIRONMENT"

wrangler d1 create "$D1" ${j[@]+"${j[@]}"} || echo "D1 database $D1 already exists"
uuid=$(wrangler d1 info "$D1" --json | jq -er .uuid)
node scripts/fleet.ts set-d1 "$id" "$uuid"
echo "Recorded d1Id $uuid in deployments/$id.jsonc"

wrangler r2 bucket create "$R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $R2 already exists"

# The AI Gateway every model call goes through: the same settings as orderloop's own
# (docs/deploy.md, "Settings for production").
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways"
  if curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/$AI_GATEWAY" >/dev/null 2>&1; then
    echo "AI Gateway $AI_GATEWAY already exists"
  else
    curl -fsS -X POST "$api" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data "$(jq -n --arg id "$AI_GATEWAY" '{
        id: $id, authentication: true, collect_logs: true,
        log_management: 100000, log_management_strategy: "DELETE_OLDEST",
        cache_ttl: 0, cache_invalidate_on_update: false,
        rate_limiting_limit: 120, rate_limiting_interval: 60, rate_limiting_technique: "sliding"
      }')" >/dev/null
    echo "Created AI Gateway $AI_GATEWAY"
  fi
else
  echo "Skipped the AI Gateway: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or create"
  echo "\"$AI_GATEWAY\" in the dashboard (AI > AI Gateway) with orderloop's settings."
fi

# The GitHub environment the deploy job runs in, and its secrets. A secret already set is left
# alone; new ones are generated and kept in .secrets/<id>/ (gitignored) for the first sign-in.
gh api --method PUT "repos/{owner}/{repo}/environments/$ENVIRONMENT" >/dev/null
# A Worker that already runs has its own secrets, set by hand or by an earlier deploy: a new
# generated one would replace them on the next deploy, so only a new deployment gets them.
if wrangler secret list --name "$WEB" >/dev/null 2>&1; then
  echo "$WEB already exists: set its secrets on $ENVIRONMENT by hand if CI should manage them."
  exit 0
fi
existing=$(gh secret list --env "$ENVIRONMENT" --json name -q '.[].name')
mkdir -p ".secrets/$id"
chmod 700 ".secrets/$id"
for name in APP_PASSWORD WEBHOOK_SECRET; do
  if grep -qx "$name" <<<"$existing"; then
    echo "$ENVIRONMENT already has $name"
    continue
  fi
  file=".secrets/$id/$(tr '[:upper:]_' '[:lower:]-' <<<"$name")"
  [ -s "$file" ] || (umask 077 && openssl rand -base64 32 | tr -d '\n' >"$file")
  gh secret set "$name" --env "$ENVIRONMENT" <"$file"
  echo "Set $name on $ENVIRONMENT (value in $file)"
done

echo
echo "Next: add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to $ENVIRONMENT if they aren't"
echo "repository secrets, commit deployments/$id.jsonc, and merge: CI deploys it in its ring."
