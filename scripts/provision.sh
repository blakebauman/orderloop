#!/usr/bin/env bash
# Creates the Cloudflare resources Order Loop needs. Safe to re-run: existing resources are kept.
set -euo pipefail
cd "$(dirname "$0")/../apps/engine"

pnpm exec wrangler d1 create orderloop || echo "D1 database orderloop already exists"
pnpm exec wrangler r2 bucket create orderloop-docs || echo "R2 bucket orderloop-docs already exists"

echo
echo "If wrangler printed a database_id, add it to the d1_databases entry in"
echo "apps/engine/wrangler.jsonc and apps/web/wrangler.jsonc (or let 'wrangler deploy' provision it)."
