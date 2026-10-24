---
name: ci-triage
description: Diagnose a failed Order Loop GitHub Actions run (CI verify job, a ring's deploy job, the docs deploy, or the nightly demo reset), classify it as a code failure, a flake, a Cloudflare API blip, missing provisioning or secrets, or a smoke-test rollback, and take the one safe next step. Use when a PR's checks are red, a merge to main didn't reach production, or the user asks why CI failed.
license: MIT
argument-hint: "[run-id | PR number | branch]"
allowed-tools: Bash(gh run list *) Bash(gh run view *) Bash(gh pr checks *) Bash(gh pr view *)
metadata:
  repo: orderloop
---

# Triage a CI failure

Workflows: `.github/workflows/ci.yml` (verify on every push and PR; on `main`, `plan` then the rings
`staging` → `internal` → `canary` → `general`), `deploy.yml` (one deployment, called per ring),
`demo-reset.yml` (nightly). `docs/deploy.md` "CI" describes them.

## 1. Find the run

```bash
gh run list --branch <branch> --limit 5            # or: gh pr checks <pr>
gh run view <run-id>                                # jobs and which failed
gh run view <run-id> --log-failed | tail -200       # the failing steps' logs
```

`$ARGUMENTS` may be a run id, a PR number or a branch.

## 2. Classify

| Where | Signal | Class | Next step |
|---|---|---|---|
| verify: Lint / Type-check / Build / Test | a compiler, Biome or vitest error with a file and line | **code** | Reproduce locally with the same command (`preflight`), fix on the branch |
| verify: Test | passes locally, fails in CI, timing-sensitive (`testTimeout`, a wait) | **flake** | Re-run once (`gh run rerun <id> --failed`, the user approves). If it fails twice, it's code: a missing `disableSleeps` / `forceEventTimeout`, or order-dependent state |
| verify: Test fleet | `scripts/fleet.test.ts` | **code** | `pnpm test:fleet` locally |
| verify: Audit dependencies | an advisory at high or critical | **dependency** | Update or override the package; say which advisory |
| plan | "missing d1Id / catalogKvId / plugin d1Id" | **provisioning** | The deployment isn't provisioned. The user runs `./scripts/provision.sh <id>`, or sets `"hold": true` |
| deploy: Check deploy credentials / Collect secrets | missing `CLOUDFLARE_API_TOKEN`, `PRINCIPAL_KEY`, `DATA_KEY`, `STRIPE_SECRET_KEY` (or wrong mode) | **secrets** | The user adds it to the deployment's GitHub environment. Nothing was migrated |
| deploy: any `wrangler` step | Cloudflare API codes `7403`, `10013`, 5xx after the `retry` helper's three attempts | **platform blip** | Re-run the failed jobs |
| deploy: Deploy (any Worker) | "queue … does not exist", a binding to a missing resource | **provisioning** | Provision for that deployment (`infra-change`), then re-run |
| deploy: Smoke test, then "Roll back on a failed deploy" ran | `/health`, `/health/deep`, `/login` or the catalog's `/health` failed | **smoke rollback** | The Workers are back on the previous version; **D1 stayed migrated**. Read which check failed and the Worker logs; fix forward in a PR. If a migration broke data, tell the user about "Restoring D1" (`docs/deploy.md`); never restore yourself |
| deploy: Latency check | a `Latency budget` warning annotation | **not a failure** | It's `continue-on-error`; nothing rolled back. Mention it if it recurs across runs |
| deploy: Deploy docs / Smoke test docs | docs build or the docs smoke checks | **docs** | Only the docs rolled back; the app is live. `pnpm docs:build` locally |
| demo-reset | the reset SQL or seed | **code** (packages/db/reset, seed) | `apps/engine/tests/demo-reset.test.ts` |

A ring that failed stops the later rings (`!failure()`); a re-run of the failed jobs continues
from there.

## 3. Act

- **Allowed:** reading runs and logs; reproducing locally; fixing on a branch; re-running failed
  jobs with `gh run rerun <run-id> --failed` after the user agrees.
- **Never:** `wrangler deploy`, `wrangler rollback`, remote migrations, a Time Travel restore,
  `gh workflow run` to redeploy, or pushing to `main` to "kick" CI. The `guard-bash` hook denies or
  asks for these.

## 4. Report

The run and job, the class, the evidence (the log lines, verbatim, trimmed), what you did, and what
the user still has to do (a secret to add, a deployment to provision, a re-run to approve).
