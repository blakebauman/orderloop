---
name: preflight
description: Run the checks CI's verify job runs (lint, type-check, tests, fleet tests, toolkit tests), scoped to the packages a change touches, and report pass or fail verbatim. Use before saying a change is done, before committing, before opening a PR, or when asked whether something is green.
license: MIT
argument-hint: "[base-ref, default origin/main]"
allowed-tools: Bash(git diff *) Bash(git status *) Bash(git merge-base *) Bash(pnpm turbo run *) Bash(pnpm lint) Bash(pnpm check-types) Bash(pnpm test) Bash(pnpm test:fleet) Bash(pnpm test:toolkit) Bash(pnpm docs:build)
metadata:
  repo: orderloop
---

# Preflight

CI's `verify` job (`.github/workflows/ci.yml`) runs lint, type-check, build, test, the fleet
tests and `pnpm audit`, each even when an earlier one failed. Run the same locally, scoped to what
changed, so a PR is green the first time.

## What changed

Committed since `origin/main`:
!`git diff --name-only origin/main...HEAD`

Uncommitted:
!`git status --short`

## Steps

1. **Base.** Use `$ARGUMENTS` as the base ref if given, else `origin/main`.
2. **Workspace checks, scoped.** Turbo's `...[ref]` filter takes every package changed since the
   ref plus everything that depends on one:
   ```bash
   pnpm turbo run lint check-types test --filter='...[origin/main]' --continue
   ```
   `--continue` reports every failure in one go, as CI does. If the changed files include the
   root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `biome.json` or
   anything under `packages/typescript-config`, run the unscoped `pnpm lint`, `pnpm check-types`
   and `pnpm test` instead.
3. **Fleet.** If anything under `deployments/` or `scripts/` changed: `pnpm test:fleet`.
4. **Toolkit.** If anything under `.claude/` changed: `pnpm test:toolkit`.
5. **Docs.** If anything under `apps/docs/` or `docs/` changed, or a generated reference source
   did (`packages/core/src/{catalog,templates,webhooks,types,policy}.ts`,
   `apps/web/app/lib/openapi.ts`): `pnpm docs:build` (includes the link check).
6. **wrangler config.** If an app's `wrangler.jsonc` changed, confirm its
   `worker-configuration.d.ts` was regenerated (`pnpm --filter @orderloop/<app> types`); a stale one
   fails type-check.

## Report

One line per check: the command, `pass` or `FAIL`. For each failure, paste the first error
verbatim with its file and line, then say whether the change caused it or it fails on the base
too (check with `git stash` only if the user agrees; otherwise say you didn't check). Never report
green for a check you didn't run.
