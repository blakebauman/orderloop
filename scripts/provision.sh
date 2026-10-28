#!/usr/bin/env bash
# Creates the Cloudflare resources and the GitHub environment for one deployment in
# deployments/<id>.jsonc, and records its D1 id there. Safe to re-run: existing resources, and
# secrets already set, are kept. See docs/operations.md.
#
#   ./scripts/provision.sh <id>
#
# Needs `wrangler login` (or CLOUDFLARE_API_TOKEN) and `gh auth login`. The AI Gateway, the
# Turnstile widget and the Logpush job are created through the API, so they also need
# CLOUDFLARE_API_TOKEN (for the widget, with Turnstile Sites Write) and CLOUDFLARE_ACCOUNT_ID;
# without them it prints what to create instead, or says what it skipped.
set -euo pipefail
id="${1:?usage: scripts/provision.sh <id>}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

eval "$(node scripts/fleet.ts names "$id")"
wrangler() { pnpm --filter @orderloop/engine exec wrangler "$@"; }
j=()
[ -n "$JURISDICTION" ] && j=(--jurisdiction "$JURISDICTION")

echo "== $id: D1 $D1, R2 $R2 and $CATALOG_R2, KV $CATALOG_KV, gateway $AI_GATEWAY, index ${PRODUCT_INDEX:-none}, https://$DOMAIN, environment $ENVIRONMENT"

wrangler d1 create "$D1" ${j[@]+"${j[@]}"} || echo "D1 database $D1 already exists"
uuid=$(wrangler d1 info "$D1" --json | jq -er .uuid)
node scripts/fleet.ts set-d1 "$id" "$uuid"
echo "Recorded d1Id $uuid in deployments/$id.jsonc"

wrangler r2 bucket create "$R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $R2 already exists"

# The product index ai.extract reads (Vectorize): bge-base-en-v1.5 embeddings, so 768 dimensions
# and cosine, fixed at creation. A deploy fails if the binding names an index that doesn't exist.
# The engine's hourly cron fills it. A demo (mock AI) has none.
if [ -n "$PRODUCT_INDEX" ]; then
  if wrangler vectorize get "$PRODUCT_INDEX" >/dev/null 2>&1; then
    echo "Vectorize index $PRODUCT_INDEX already exists"
  else
    wrangler vectorize create "$PRODUCT_INDEX" --dimensions 768 --metric cosine
  fi
fi

# Each installed plugin's own D1 database (docs/plugins.md), named like its Worker.
for p in $PLUGINS; do
  pdb="orderloop-plugin-$p$SUFFIX"
  wrangler d1 create "$pdb" ${j[@]+"${j[@]}"} || echo "D1 database $pdb already exists"
  puuid=$(wrangler d1 info "$pdb" --json | jq -er .uuid)
  node scripts/fleet.ts set-plugin-d1 "$id" "$p" "$puuid"
  echo "Recorded plugins.$p.d1Id $puuid in deployments/$id.jsonc"
done
# A deployment on its own Cloudflare account keeps plugin secrets in that account's Secrets Store
# (docs/plugins.md, "Secrets"): one store an account, made in the dashboard or with
# `wrangler secrets-store store create <name> --remote`; its id goes in the registry's secretsStore.
if [ -n "$SECRETS_STORE" ]; then
  if wrangler secrets-store store list --remote 2>/dev/null | grep -q "$SECRETS_STORE"; then
    echo "Secrets Store $SECRETS_STORE found; add each plugin's PLUGIN_<ID>_<NAME> to it"
  else
    echo "Secrets Store $SECRETS_STORE not found in this account: create it, or fix secretsStore.storeId" >&2
    exit 1
  fi
fi
for p in $SANDBOXED_PLUGINS; do
  echo "Plugin $p is sandboxed: nothing to create (the deploy publishes its bundle)"
done

# The catalog: published documents in R2, listing cards in KV (KV has no jurisdictions).
wrangler r2 bucket create "$CATALOG_R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $CATALOG_R2 already exists"
kv_id() { wrangler kv namespace list | jq -er --arg t "$CATALOG_KV" '.[] | select(.title == $t) | .id'; }
kv=$(kv_id 2>/dev/null) || { wrangler kv namespace create "$CATALOG_KV" >/dev/null; kv=$(kv_id); }
node scripts/fleet.ts set-catalog-kv "$id" "$kv"
echo "Recorded catalogKvId $kv in deployments/$id.jsonc"
# Feed files and their parts are only needed while a feed imports. Replaced on each run, like the
# audit rule above.
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name feeds ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" feeds feeds/ --expire-days 30 --force ${j[@]+"${j[@]}"}
# Dead letters the catalog keeps (dlq/<queue>/<date>/<id>.json) are for inspection and replay
# (docs/operations.md, "Dead letters"); a month is long enough to act on one. Replaced each run.
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name dlq ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" dlq dlq/ --expire-days 30 --force ${j[@]+"${j[@]}"}
# The catalog's daily backups (backups/<date>/, docs/operations.md "Catalog backups") expire after
# catalogBackupDays, and the copies a point-in-time restore keeps of what was published
# (restores/<instance>/) after 30 days. Replaced each run, so a changed number takes effect.
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name backups ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" backups backups/ --expire-days "$CATALOG_BACKUP_DAYS" \
  --force ${j[@]+"${j[@]}"}
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name restores ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" restores restores/ --expire-days 30 --force ${j[@]+"${j[@]}"}
# The deploy smoke test's write check deletes its health/ object as it ends; one whose check was
# cut off (a timeout) is gone a day later. Replaced each run, on both buckets.
wrangler r2 bucket lifecycle remove "$CATALOG_R2" --name health ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$CATALOG_R2" health health/ --expire-days 1 --force ${j[@]+"${j[@]}"}
# And nothing deletes or overwrites a backup before then: a lock of the same age, so the lifecycle
# rule and the lock never disagree. The backup Workflow skips a key that exists, as the lock needs.
# `lock set` replaces the bucket's whole lock configuration: this is the catalog bucket's only rule.
catalog_locks=$(mktemp)
jq -n --argjson d "$CATALOG_BACKUP_DAYS" '{rules: [
  {id: "catalog-backups", enabled: true, prefix: "backups/", condition: {type: "Age", maxAgeSeconds: ($d * 86400)}}
]}' >"$catalog_locks"
wrangler r2 bucket lock set "$CATALOG_R2" --file "$catalog_locks" --force ${j[@]+"${j[@]}"}
rm -f "$catalog_locks"
echo "Catalog backups in $CATALOG_R2 kept and locked $CATALOG_BACKUP_DAYS days"
# The queues feed parts, urgent purges and listing changes go through, and their dead-letter queues. A deploy fails if
# the consumer's queue is missing, so a queue that can't be created or found stops provisioning.
# Each keeps messages 14 days (the most Queues allows), set on existing queues too, so a consumer
# that is down over a long weekend loses nothing.
for q in "$CATALOG_FEED_PARTS" "$CATALOG_FEED_PARTS_DLQ" "$CATALOG_PURGE" "$CATALOG_PURGE_DLQ" \
  "$CATALOG_CHANGES" "$CATALOG_CHANGES_DLQ"; do
  if wrangler queues info "$q" >/dev/null 2>&1; then echo "Queue $q already exists"
  else wrangler queues create "$q"; fi
  wrangler queues update "$q" --message-retention-period-secs 1209600 >/dev/null
  echo "Queue $q keeps messages 14 days"
done

# How long the R2 archive keeps audit events (auditArchiveDays): the rule is replaced on each run,
# so a changed number takes effect; without one, archived events are kept.
wrangler r2 bucket lifecycle remove "$R2" --name audit-archive ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
if [ -n "$AUDIT_ARCHIVE_DAYS" ]; then
  wrangler r2 bucket lifecycle add "$R2" audit-archive audit/ --expire-days "$AUDIT_ARCHIVE_DAYS" \
    --force ${j[@]+"${j[@]}"}
  echo "Archived audit events in $R2 expire after $AUDIT_ARCHIVE_DAYS days"
fi

# The write check's leftovers in the docs bucket, as in the catalog's above.
wrangler r2 bucket lifecycle remove "$R2" --name health ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$R2" health health/ --expire-days 1 --force ${j[@]+"${j[@]}"}

# Bucket locks on the same bucket: nothing deletes the audit archive before the lifecycle rule
# above expires it (the same number of days, so the two never disagree; kept indefinitely when
# auditArchiveDays is unset), nor a pinned sandboxed-plugin bundle, which a rollback reloads.
# `lock set` replaces the bucket's whole lock configuration in one call, so a re-run changes the
# audit retention without a moment unlocked; a lock added to this bucket by hand is replaced too.
if [ -n "$AUDIT_ARCHIVE_DAYS" ]; then
  audit_lock=$(jq -n --argjson d "$AUDIT_ARCHIVE_DAYS" '{type: "Age", maxAgeSeconds: ($d * 86400)}')
else
  audit_lock='{"type":"Indefinite"}'
fi
locks=$(mktemp)
trap 'rm -f "$locks"' EXIT
jq -n --argjson audit "$audit_lock" '{rules: [
  {id: "audit-archive", enabled: true, prefix: "audit/", condition: $audit},
  {id: "plugin-bundles", enabled: true, prefix: "plugins/", condition: {type: "Indefinite"}}
]}' >"$locks"
wrangler r2 bucket lock set "$R2" --file "$locks" --force ${j[@]+"${j[@]}"}
echo "Locked audit/ (${AUDIT_ARCHIVE_DAYS:-indefinitely}${AUDIT_ARCHIVE_DAYS:+ days}) and plugins/ (indefinitely) in $R2"

# The AI Gateway every model call goes through: the same settings as orderloop's own
# (docs/deploy.md, "Settings for production").
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  api="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai-gateway/gateways"
  if existing_gw=$(curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$api/$AI_GATEWAY" 2>/dev/null); then
    echo "AI Gateway $AI_GATEWAY already exists"
    if [ "$(jq -r '.result.collect_logs' <<<"$existing_gw")" != "$AI_GATEWAY_LOGS" ]; then
      echo "  Its default for request logs differs from aiGatewayLogs ($AI_GATEWAY_LOGS). The engine"
      echo "  sends aiGatewayLogs on every call, so this only matters for calls made outside it; match"
      echo "  it in the dashboard (AI > AI Gateway > $AI_GATEWAY > Settings), and delete logs kept so far."
    fi
    if [ "$(jq -r '[.result.retry_max_attempts, .result.retry_delay, .result.retry_backoff] | map(tostring) | join(" ")' <<<"$existing_gw")" != "3 500 exponential" ]; then
      echo "  Its retries aren't orderloop's (3 attempts, 500 ms, exponential): set them in the"
      echo "  dashboard (AI > AI Gateway > $AI_GATEWAY > Settings > Retry Requests)."
    fi
  else
    curl -fsS -X POST "$api" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
      -H 'Content-Type: application/json' \
      --data "$(jq -n --arg id "$AI_GATEWAY" --argjson logs "$AI_GATEWAY_LOGS" '{
        id: $id, authentication: true, collect_logs: $logs,
        log_management: 100000, log_management_strategy: "DELETE_OLDEST",
        cache_ttl: 0, cache_invalidate_on_update: false,
        rate_limiting_limit: 120, rate_limiting_interval: 60, rate_limiting_technique: "sliding",
        retry_max_attempts: 3, retry_delay: 500, retry_backoff: "exponential"
      }')" >/dev/null
    echo "Created AI Gateway $AI_GATEWAY"
  fi
else
  echo "Skipped the AI Gateway: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or create"
  echo "\"$AI_GATEWAY\" in the dashboard (AI > AI Gateway) with orderloop's settings."
fi

# The logs bucket: Logpush writes the deployment's Workers' trace events there, under workers/<date>/
# (docs/operations.md, "Logs"). A bucket of its own, so the R2 token Logpush holds can write nothing
# else of the deployment's. They expire after logRetentionDays: the rule is replaced on each run, so
# a changed number takes effect.
logpush_spec=$(node scripts/fleet.ts logpush "$id")
logs_prefix=$(jq -er .prefix <<<"$logpush_spec")
wrangler r2 bucket create "$LOGS_R2" ${j[@]+"${j[@]}"} || echo "R2 bucket $LOGS_R2 already exists"
wrangler r2 bucket lifecycle remove "$LOGS_R2" --name logs ${j[@]+"${j[@]}"} >/dev/null 2>&1 || true
wrangler r2 bucket lifecycle add "$LOGS_R2" logs "$logs_prefix" --expire-days "$LOG_RETENTION_DAYS" \
  --force ${j[@]+"${j[@]}"}
echo "Logs in $LOGS_R2 expire after $LOG_RETENTION_DAYS days"

# The Logpush job that fills it: workers_trace_events from this deployment's Workers only (a filter
# by script name; every Worker on the account that sets `logpush` would reach it otherwise), with
# the fields `fleet.ts logpush` lists. Found by name and updated in place on a re-run, its key kept.
# Creating one also makes its key, so CLOUDFLARE_API_TOKEN then needs Account API Tokens Write as
# well as Logs Write. ROTATE_LOGPUSH_KEY=1 rolls the key and gives the job the new one. Tracing is
# off throughout (and restored after), since the key passes through this shell.
case $- in *x*) logpush_xtrace=1 ;; *) logpush_xtrace="" ;; esac
set +x
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  acct="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
  # Whatever the API says back, minus any key it quotes from a destination.
  redact() { sed -E 's/(secret-access-key|access-key-id)=[^&"[:space:]]*/\1=REDACTED/g'; }
  # One Cloudflare API call, its response on stdout; stops provisioning on a failure, naming it.
  # The API token reaches curl through a pipe and a body through stdin, never its arguments.
  cf() {
    local out
    if [ "$1" = GET ]; then
      out=$(curl -sS "$acct$2" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN"))
    else
      out=$(curl -sS -X "$1" "$acct$2" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") \
        -H 'Content-Type: application/json' --data-binary @-)
    fi
    if ! jq -e .success >/dev/null 2>&1 <<<"$out"; then
      echo "Cloudflare API $1 ${2%%\?*}: $(jq -r '[.errors[]?.message] | join("; ")' <<<"$out" 2>/dev/null | redact)" >&2
      return 1
    fi
    printf '%s' "$out"
  }
  # Logpush signs its writes to R2 as an S3 client: the access key id is an API token's id, the
  # secret the SHA-256 of its value. The token is the account's, named for the deployment, and may
  # only write objects in the logs bucket (`logpushToken` in fleet.ts builds it). Its value stays in
  # this shell and in the job's destination: never printed, never on disk. An existing token is
  # rolled rather than duplicated, and only once it holds exactly that policy. It runs in a command
  # substitution, where bash drops `set -e`, so each step returns on failure.
  logpush_destination() {
    local tid="" page=1 listed body pg made value secret
    body=$(cf GET "/tokens/permission_groups?name=Workers%20R2%20Storage%20Bucket%20Item%20Write" |
      node scripts/fleet.ts logpush-token "$id" "$CLOUDFLARE_ACCOUNT_ID") || return 1
    pg=$(jq -er '.policies[0].permission_groups[0].id' <<<"$body") || return 1
    while :; do
      listed=$(cf GET "/tokens?per_page=50&page=$page") || return 1
      [ "$(jq '.result | length' <<<"$listed")" = 0 ] && break
      tid=$(jq -r --arg n "$LOGPUSH_TOKEN" '[.result[] | select(.name == $n)][0].id // empty' <<<"$listed")
      [ -n "$tid" ] && break
      page=$((page + 1))
    done
    if [ -n "$tid" ]; then
      cf GET "/tokens/$tid" | node scripts/fleet.ts logpush-token "$id" "$CLOUDFLARE_ACCOUNT_ID" check "$pg" ||
        return 1
      value=$(cf PUT "/tokens/$tid/value" <<<'{}' | jq -er .result) || return 1
    else
      made=$(cf POST /tokens <<<"$body") || return 1
      tid=$(jq -er .result.id <<<"$made") || return 1
      value=$(jq -er .result.value <<<"$made") || return 1
    fi
    secret=$(printf '%s' "$value" | openssl dgst -sha256 -r | cut -d' ' -f1) || return 1
    # A bucket in a jurisdiction is reached through its S3 endpoint; the r2:// form is for the default.
    if [ -n "$JURISDICTION" ]; then
      printf 's3://%s/%s{DATE}?region=auto&endpoint=%s.%s.r2.cloudflarestorage.com&access-key-id=%s&secret-access-key=%s' \
        "$LOGS_R2" "$logs_prefix" "$CLOUDFLARE_ACCOUNT_ID" "$JURISDICTION" "$tid" "$secret"
    else
      printf 'r2://%s/%s{DATE}?account-id=%s&access-key-id=%s&secret-access-key=%s' \
        "$LOGS_R2" "$logs_prefix" "$CLOUDFLARE_ACCOUNT_ID" "$tid" "$secret"
    fi
  }
  jobs=$(cf GET /logpush/datasets/workers_trace_events/jobs)
  # `logpush` puts these Workers in every workers_trace_events job on the account: refuse while one
  # that isn't this deployment's (an unfiltered one, say) would take their logs too.
  node scripts/fleet.ts logpush-foreign "$id" <<<"$jobs"
  job_id=$(jq -r --arg n "$LOGPUSH_JOB" '[.result[] | select(.name == $n)][0].id // empty' <<<"$jobs")
  job=$(jq '{enabled: true, filter, output_options}' <<<"$logpush_spec")
  if [ -n "$job_id" ]; then
    if [ "${ROTATE_LOGPUSH_KEY:-}" = 1 ]; then
      dest=$(logpush_destination)
      job=$(jq --rawfile d <(printf '%s' "$dest") '. + {destination_conf: $d}' <<<"$job")
    fi
    updated=$(cf PUT "/logpush/jobs/$job_id" <<<"$job")
    echo "Logpush job $LOGPUSH_JOB updated: $(jq -r '.scripts | join(", ")' <<<"$logpush_spec") to $LOGS_R2${ROTATE_LOGPUSH_KEY:+ (new key)}"
    last_error=$(jq -r '.result.error_message // empty' <<<"$updated" | redact)
    if [ -n "$last_error" ]; then
      echo "  Its last push failed: $last_error (ROTATE_LOGPUSH_KEY=1 gives it a new key)"
    fi
  else
    dest=$(logpush_destination)
    job=$(jq --arg n "$LOGPUSH_JOB" --rawfile d <(printf '%s' "$dest") \
      '. + {name: $n, dataset: "workers_trace_events", destination_conf: $d}' <<<"$job")
    if ! created=$(cf POST /logpush/jobs <<<"$job" 2>&1); then
      echo "$created" >&2
      if grep -qi 'max jobs' <<<"$created"; then
        echo "The account has as many workers_trace_events jobs as Logpush allows: ask Cloudflare to" >&2
        echo "raise it, or give $id its own account (docs/operations.md, \"Logs\")." >&2
      fi
      exit 1
    fi
    echo "Created Logpush job $LOGPUSH_JOB: $(jq -r '.scripts | join(", ")' <<<"$logpush_spec") to $LOGS_R2"
  fi
else
  echo "Skipped the Logpush job: set CLOUDFLARE_API_TOKEN (Logs Write, and Account API Tokens Write"
  echo "to create it) and CLOUDFLARE_ACCOUNT_ID, and run this again. Until then nothing is pushed."
fi
if [ -n "$logpush_xtrace" ]; then set -x; fi

# The GitHub environment the deploy job runs in, and its secrets. A secret already set is left
# alone; the setup code is generated and kept in .secrets/<id>/ (gitignored) for the first admin.
gh api --method PUT "repos/{owner}/{repo}/environments/$ENVIRONMENT" >/dev/null
# The keys both Workers share: PRINCIPAL_KEY signs the requests the web Worker forwards and the
# engine checks; DATA_KEY encrypts the secrets they store. CI sets them on both Workers and won't
# deploy without them, so a deployment that already runs gets them here too. PASSWORD_PEPPER is
# mixed into the web Worker's password hashes; a deployment that adds it later keeps working
# (older hashes are stored again with it at each sign-in), but once set it must never change or
# go: every password hashed with it would stop verifying. The same holds for DATA_KEY, which
# sealed every stored secret, so neither is generated while the web Worker already holds one: a
# new value would replace it on the next deploy. None is ever written to disk.
EXISTING=$(gh secret list --env "$ENVIRONMENT" --json name -q '.[].name')
RUNNING=false
WORKER_SECRETS=""
if WORKER_SECRETS=$(wrangler secret list --name "$WEB" 2>/dev/null); then
  RUNNING=true
  WORKER_SECRETS=$(jq -r '.[].name' <<<"$WORKER_SECRETS" 2>/dev/null || true)
fi
for KEY in PRINCIPAL_KEY DATA_KEY PASSWORD_PEPPER; do
  if grep -qx "$KEY" <<<"$EXISTING"; then
    echo "$ENVIRONMENT already has $KEY"
  elif [ "$KEY" != PRINCIPAL_KEY ] && grep -qx "$KEY" <<<"$WORKER_SECRETS"; then
    echo "$ENVIRONMENT has no $KEY, but $WEB already holds one. Set the deployment's own value on"
    echo "$ENVIRONMENT from its escrowed copy; a new one would make what it protects unreadable."
    exit 1
  else
    openssl rand -hex 32 | tr -d '\n' | gh secret set "$KEY" --env "$ENVIRONMENT"
    echo "Set $KEY on $ENVIRONMENT"
  fi
done
# The Turnstile widget on password sign-in and /setup (docs/operations.md, "Turnstile"): managed,
# for the deployment's domain alone, and named like its web Worker, so each deployment on a shared
# account finds its own. Its site key is public: it goes in the registry, which turns the check on.
# Its secret goes from the API straight into the environment, as TURNSTILE_SECRET_KEY, and nowhere
# else: never printed, never on disk. Set it before the registry has the key, or the deploy stops.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  widgets="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/challenges/widgets"
  cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$@"; }
  # Every widget in the account, one JSON object a line, page by page.
  list_widgets() {
    local page=1 pages=1 body
    while [ "$page" -le "$pages" ]; do
      body=$(cf "$widgets?per_page=1000&page=$page")
      jq -c '.result[] | {sitekey, name, domains}' <<<"$body"
      pages=$(jq -r '.result_info.total_pages // 1' <<<"$body")
      page=$((page + 1))
    done
  }
  all_widgets=$(list_widgets)
  # The registry's key names the widget when it has one; otherwise the name does.
  if [ -n "$TURNSTILE_SITE_KEY" ]; then
    sitekey=$(jq -rs --arg k "$TURNSTILE_SITE_KEY" 'map(select(.sitekey == $k))[0].sitekey // empty' <<<"$all_widgets")
    if [ -z "$sitekey" ]; then
      echo "turnstileSiteKey in deployments/$id.jsonc is no widget in this account: fix it, or remove" >&2
      echo "it to find or create $WEB" >&2
      exit 1
    fi
  else
    named=$(jq -s --arg n "$WEB" 'map(select(.name == $n)) | length' <<<"$all_widgets")
    [ "$named" -gt 1 ] && echo "WARNING: $named Turnstile widgets are named $WEB; using the first" >&2
    sitekey=$(jq -rs --arg n "$WEB" 'map(select(.name == $n))[0].sitekey // empty' <<<"$all_widgets")
  fi
  if [ -n "$sitekey" ]; then
    echo "Turnstile widget $WEB already exists"
    # Its domains are where its tokens can be solved: anything besides this deployment's is a
    # widget shared with, or left over from, something else.
    domains=$(jq -cs --arg k "$sitekey" 'map(select(.sitekey == $k))[0].domains | sort' <<<"$all_widgets")
    if [ "$domains" != "$(jq -cn --arg d "$DOMAIN" '[$d]')" ]; then
      echo "WARNING: Turnstile widget $sitekey has domains $domains, not [\"$DOMAIN\"]." >&2
      echo "WARNING: give it exactly $DOMAIN in the dashboard (Turnstile > the widget > Hostnames)." >&2
    fi
  else
    # Only the site key is read from the answer; the secret is fetched below, if it's needed.
    sitekey=$(cf -X POST "$widgets" -H 'Content-Type: application/json' \
      --data "$(jq -n --arg n "$WEB" --arg d "$DOMAIN" '{name: $n, domains: [$d], mode: "managed"}')" |
      jq -er .result.sitekey)
    echo "Created Turnstile widget $WEB for $DOMAIN"
  fi
  if grep -qx TURNSTILE_SECRET_KEY <<<"$EXISTING"; then
    echo "$ENVIRONMENT already has TURNSTILE_SECRET_KEY"
  else
    (
      set +x
      secret=$(cf "$widgets/$sitekey" | jq -jer .result.secret)
      [ -n "$secret" ] || { echo "Turnstile widget $WEB returned no secret" >&2; exit 1; }
      printf '%s' "$secret" | gh secret set TURNSTILE_SECRET_KEY --env "$ENVIRONMENT"
    )
    echo "Set TURNSTILE_SECRET_KEY on $ENVIRONMENT"
  fi
  if [ "$TURNSTILE_SITE_KEY" = "$sitekey" ]; then
    echo "deployments/$id.jsonc has the widget's turnstileSiteKey"
  else
    echo "To turn on Turnstile, set \"turnstileSiteKey\": \"$sitekey\" in deployments/$id.jsonc"
  fi
else
  echo "Skipped the Turnstile widget: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, or create"
  echo "\"$WEB\" in the dashboard (Turnstile > Add widget: managed, domain $DOMAIN), set its secret as"
  echo "TURNSTILE_SECRET_KEY on $ENVIRONMENT, and its site key as turnstileSiteKey in the registry."
fi

# A Worker that already runs has its own secrets, set by hand or by an earlier deploy: a new
# generated one would replace them on the next deploy, so only a new deployment gets them.
if $RUNNING; then
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
