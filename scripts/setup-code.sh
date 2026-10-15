#!/usr/bin/env bash
# Issues a new one-time setup code for a running deployment, for when no admin can sign in. The
# code opens /setup once, to create one new admin account, and both its use and every wrong guess
# go to the audit log. See docs/operations.md, "Recovering admin access".
#
#   ./scripts/setup-code.sh <id>
#
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) and `gh auth login`. The code is written to
# .secrets/<id>/setup-code (gitignored) and never printed.
set -euo pipefail
id="${1:?usage: scripts/setup-code.sh <id>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

eval "$(node scripts/fleet.ts names "$id")"
mkdir -p ".secrets/$id"
chmod 700 ".secrets/$id"
file=".secrets/$id/setup-code"
(umask 077 && openssl rand -hex 16 | tr -d '\n' >"$file")
# On the environment, so the next deploy keeps it; on the Worker, so it works now.
gh secret set SETUP_TOKEN --env "$ENVIRONMENT" <"$file"
pnpm --filter @orderloop/web exec wrangler secret put SETUP_TOKEN --name "$WEB" <"$file" >/dev/null
echo "New setup code for $id in $file. Send it, with https://$DOMAIN/setup, to the person"
echo "recovering access; it creates one admin account and then stops working."
