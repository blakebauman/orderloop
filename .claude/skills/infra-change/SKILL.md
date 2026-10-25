---
name: infra-change
description: Change Order Loop's Cloudflare configuration safely across the fleet. Covers adding or changing a binding, var, queue, bucket, KV namespace, Durable Object, Workflow, route or compatibility flag in an app's wrangler.jsonc; rendering it per deployment in scripts/fleet.ts; creating it in scripts/provision.sh; registry fields in deployments/*.jsonc; regenerating worker types; and ordering the rollout so CI's deploy never needs a resource that doesn't exist yet. Use for any edit to wrangler.jsonc, deployments/, scripts/fleet.ts or scripts/provision.sh.
license: MIT
metadata:
  repo: orderloop
---

# Changing infrastructure

Every customer is its own deployment (`deployments/<id>.jsonc`), with its own copies of every
resource, named with the deployment's suffix. The base config is each app's `wrangler.jsonc`;
`scripts/fleet.ts render <id>` writes `wrangler.<id>.json` next to it with that deployment's names
and ids, and CI deploys those. `docs/operations.md` (the registry, resource names, adding a
customer) and `docs/configuration.md` (vars, secrets, bindings, routes) are the references; read
the relevant section first.

## Checklist for a wrangler.jsonc change

1. **Edit the base** `apps/<app>/wrangler.jsonc` (or `plugins/<id>/wrangler.jsonc`). Base names
   are the `orderloop` deployment's (suffix `""`).
2. **Regenerate types:** `pnpm --filter @orderloop/<app> types`. Never hand-edit
   `worker-configuration.d.ts` (the `block-generated` hook denies it).
3. **Render per deployment** in `scripts/fleet.ts` (`renderEngine`, `renderCatalog`,
   `renderPlugin`, the web and edge renderers): a new resource name gets the suffix, a new id comes
   from the registry, a new per-customer setting becomes a registry field with validation and a
   default.
4. **Create it per deployment** in `scripts/provision.sh` if it's a resource that must exist
   before deploy (D1, R2, KV, queues, AI Gateway, lifecycle rules). Keep the script re-runnable:
   find-or-create, never replace a secret that's set.
5. **Test the fleet:** `pnpm test:fleet`. It checks that rendering `orderloop` returns the base
   files unchanged, and that bad registry values are refused.
6. **Document** it in `docs/configuration.md` (and `docs/operations.md` for a registry field or a
   new resource name). Keep `wrangler`, bindings and env vars out of the published `apps/docs`.

## Rollout order

CI deploys every deployment from `main` in ring order. Nothing provisions during CI. So:

- **A new resource a deploy needs** (a queue the Worker consumes, a KV namespace whose id is
  required to render) must exist in every deployment **before** the merge that binds it. Run
  `./scripts/provision.sh <id>` for each existing deployment first (the user runs it; the
  `guard-bash` hook asks before you do), or merge the deployment with `"hold": true`. Say this in
  the PR description, listing the deployments.
- A deployment missing `d1Id`, `catalogKvId` or a plugin's `d1Id` stops the whole CI plan.
- **A renamed binding or resource** is expand/contract like a migration: add the new one, deploy,
  move reads and writes, then remove the old one in a later change.
- **Durable Object classes** need a `migrations` entry with a new tag (`new_sqlite_classes`),
  appended at the end of the app's `wrangler.jsonc` and to `APPLIED` in
  `scripts/do-migrations.test.ts` in the same change; never edit, remove or reorder an existing
  tag. That test (in `pnpm test:fleet`) fails CI on any of those, and on `deleted_classes`,
  `renamed_classes` or `transferred_classes`: a rename or delete of a DO class holding data is a
  data migration; plan it with the user, then allowlist it there (`DESTRUCTIVE_ALLOWED`).
- **Workflow names** are unique per account, which is why they carry the suffix.
- **Jurisdiction** is fixed at creation for D1, R2 and Durable Objects; never add or change it for
  a deployment that has orders.
- `orderloop`'s own resources are sometimes created through the Cloudflare API rather than
  `provision.sh`; `docs/operations.md` records which.

## Secrets

Secrets aren't in `wrangler.jsonc`. CI writes them from the deployment's GitHub environment
(`node scripts/fleet.ts secrets <engine|web|plugin> <out>`). A new secret means: read it in
`fleet.ts secrets`, add it to the environment (the user does, or `provision.sh` for generated
ones), and list it in `docs/configuration.md`. Never commit a secret or write one to disk outside
`.secrets/` (gitignored).

## Never

`wrangler deploy`, `wrangler rollback`, `wrangler d1 migrations apply --remote`, deleting a
deployment's resource, or `pnpm deploy` by hand. The `guard-bash` hook denies them; CI does them.
