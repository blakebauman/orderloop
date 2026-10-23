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

echo "== $id: D1 $D1, R2 $R2 and $CATALOG_R2, KV $CATALOG_KV, gateway $AI_GATEWAY, https://$DOMAIN, environment $ENVIRONMENT"

wrangler d1 create "$D1" ${j[@]+"${j[@]}"} || echo "D1 database $D1 already exists"
uuid=$(wrangler d1 info "$D1" --json | jq -er .uuid)
node scripts/fleet.ts set-d1 "$id" "$uuid"
echo "Recorded d1Id $uuid in deployments/$id.jsonc"

wrangler r2 bucket create "$R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $R2 already exists"

# The catalog: published documents in R2, listing cards in KV (KV has no jurisdictions).
wrangler r2 bucket create "$CATALOG_R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $CATALOG_R2 already exists"
kv_id() { wrangler kv namespace list | jq -er --arg t "$CATALOG_KV" '.[] | select(.title == $t) | .id'; }
kv=$(kv_id 2>/dev/null) || { wrangler kv namespace create "$CATALOG_KV" >/dev/null; kv=$(kv_id); }
node scripts/fleet.ts set-catalog-kv "$id" "$kv"
echo "Recorded catalogKvId $kv in deployments/$id.jsonc"

# How long the R2 archive keeps audit events (auditArchiveDays): the rule is replaced on each run,
# so a changed number takes effect; without one, archived events are kept.
wrangler r2 bucket lifecycle remove "$R2" --name audit-archive ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
if [ -n "$AUDIT_ARCHIVE_DAYS" ]; then
  wrangler r2 bucket lifecycle add "$R2" audit-archive audit/ --expire-days "$AUDIT_ARCHIVE_DAYS" \
    --force ${j[@]+"${j[@]}"}
  echo "Archived audit events in $R2 expire after $AUDIT_ARCHIVE_DAYS days"
fi

# The AI Gateway every model call goes through: the same settings as orderloop's own
# (docs/deploy.md, "Settings for production").
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways"
  if existing_gw=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/$AI_GATEWAY" 2>/dev/null); then
    echo "AI Gateway $AI_GATEWAY already exists"
    if [ "$(jq -r '.result.collect_logs' <<<"$existing_gw")" != "$AI_GATEWAY_LOGS" ]; then
      echo "  Its request logs don't match aiGatewayLogs ($AI_GATEWAY_LOGS): change them in the"
      echo "  dashboard (AI > AI Gateway > $AI_GATEWAY > Settings)."
    fi
  else
    curl -fsS -X POST "$api" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data "$(jq -n --arg id "$AI_GATEWAY" --argjson logs "$AI_GATEWAY_LOGS" '{
        id: $id, authentication: true, collect_logs: $logs,
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
# alone; the setup code is generated and kept in .secrets/<id>/ (gitignored) for the first admin.
gh api --method PUT "repos/{owner}/{repo}/environments/$ENVIRONMENT" >/dev/null
# The keys both Workers share: PRINCIPAL_KEY signs the requests the web Worker forwards and the
# engine checks; DATA_KEY encrypts the secrets they store. CI sets them on both Workers and won't
# deploy without them, so a deployment that already runs gets them here too. Neither is ever
# written to disk.
EXISTING=$(gh secret list --env "$ENVIRONMENT" --json name -q '.[].name')
for KEY in PRINCIPAL_KEY DATA_KEY; do
  if grep -qx "$KEY" <<<"$EXISTING"; then
    echo "$ENVIRONMENT already has $KEY"
  else
    openssl rand -hex 32 | tr -d '\n' | gh secret set "$KEY" --env "$ENVIRONMENT"
    echo "Set $KEY on $ENVIRONMENT"
  fi
done
# A Worker that already runs has its own secrets, set by hand or by an earlier deploy: a new
# generated one would replace them on the next deploy, so only a new deployment gets them.
if wrangler secret list --name "$WEB" >/dev/null 2>&1; then
  echo "$WEB already exists: set its secrets on $ENVIRONMENT by hand if CI should manage them."
  exit 0
fi
existing=$(gh secret list --env "$ENVIRONMENT" --json name -q '.[].name')
mkdir -p ".secrets/$id"
chmod 700 ".secrets/$id"
file=".secrets/$id/setup-code"
if grep -qx SETUP_TOKEN <<<"$existing"; then
  echo "$ENVIRONMENT already has SETUP_TOKEN"
else
  [ -s "$file" ] || (umask 077 && openssl rand -hex 16 | tr -d '\n' >"$file")
  gh secret set SETUP_TOKEN --env "$ENVIRONMENT" <"$file"
  echo "Set SETUP_TOKEN on $ENVIRONMENT (value in $file)"
fi

echo
echo "Next: add CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to $ENVIRONMENT if they aren't"
echo "repository secrets, commit deployments/$id.jsonc, and merge: CI deploys it in its ring."
echo "Then send the customer's first admin https://$DOMAIN/setup and the setup code in $file."
