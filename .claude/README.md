# Order Loop Claude Code toolkit

Project-scoped agents, skills and hooks for this repo, version-controlled and reviewed like source.
AGENTS.md states the rules (CLAUDE.md imports it). This toolkit splits how they're kept:

- **Hooks** enforce what a machine can check: they deny, ask or remind, every time.
- **Skills** carry the procedures and the reasons behind the rules.
- **Subagents** do the work that needs judgement (building, testing, reviewing, operating,
  documenting) in their own context, with tools scoped to the job.

Skills follow the [Agent Skills](https://agentskills.io/specification) format. Agents and hooks
follow Claude Code's [subagents](https://code.claude.com/docs/en/sub-agents) and
[hooks](https://code.claude.com/docs/en/hooks-guide).

## Which tool for which job

| You want to… | Use |
|---|---|
| Build a feature or fix a bug | `engineer` agent (or the main session), with `orderloop-conventions` |
| Add a node type, a migration, a binding | `/add-node-type`, `/d1-migration`, `/infra-change` |
| Write or de-flake tests | `test-engineer` agent, `testing` skill |
| Know whether it's green | `/preflight` |
| Review before a PR | `/review-change`, which runs `code-reviewer` + `security-reviewer` in parallel |
| Open the PR | `/ship` (worktree, preflight, commit, push the branch, `gh pr create`; never merges) |
| Find out why CI is red | `/ci-triage`, or the `devops` agent |
| Change CI, the fleet or provisioning | `devops` agent |
| Check the repo's instructions still match reality | `dx-reviewer` agent |
| Audit a deployment's production readiness on Cloudflare | `readiness-auditor` agent |
| Review Workers AI and AI Gateway use: gaps, robustness, new use cases | `ai-reviewer` agent |
| Keep the docs true | `docs-sync` agent or skill, `/docs-page`, `/docs-audit` |

## Subagents (`agents/`)

| Agent | Tools | Preloads | Use it for |
|---|---|---|---|
| `engineer` | all | `orderloop-conventions`, `testing` | Implementing a scoped change within the invariants, with tests and preflight. Never deploys or merges |
| `test-engineer` | Read, Grep, Glob, Edit, Write, Bash | `testing`, `orderloop-conventions` | Tests only: coverage, failure paths, de-flaking. Reports production bugs instead of fixing them |
| `code-reviewer` | Read, Grep, Glob, Bash | `orderloop-conventions` | Ranked correctness findings with a failure scenario each. **Read-only** |
| `security-reviewer` | Read, Grep, Glob, Bash | `security-model` | Findings per trust boundary with attacker, scenario and fix. **Read-only** |
| `devops` | Read, Grep, Glob, Edit, Write, Bash | `infra-change`, `ci-triage` | Workflows, the fleet registry, `fleet.ts`, `provision.sh`, `wrangler.jsonc`, rollout order, CI triage. Never deploys |
| `dx-reviewer` | Read, Grep, Glob, Bash | none | Instructions vs reality: README, CLAUDE.md, AGENTS.md, `docs/`, scripts, this toolkit. **Read-only** |
| `readiness-auditor` | Read, Grep, Glob, Bash, Cloudflare API MCP (GET only) | `infra-change` | Template and live-account audit: DNS, TLS, edge, config, DOs and Workflows, durability, rollback, alerting, cost. **Read-only** |
| `ai-reviewer` | Read, Grep, Glob, Bash, Cloudflare API MCP (GET, plus read-only GraphQL analytics) | `orderloop-conventions` | Model calls and fallbacks, AI Gateway settings, model choice against the current catalog, live error and usage numbers, use cases that keep step determinism. **Read-only** |
| `docs-sync` | Bash, Read, Grep, Glob, Edit, Write | `docs-sync`, `docs-page` | Mapping a change to doc pages, verifying claims against the source, rebuilding |

The reviewers can't edit, so their findings don't depend on a fix they made. Give them the base
ref and the changed files, not your conclusions.

## Skills (`skills/`)

Invoke with `/<name>`, or let Claude pick them by description. Background skills don't appear in
the `/` menu. They load when relevant and are preloaded by agents.

| Skill | Kind | Use it for |
|---|---|---|
| `orderloop-conventions` | background | Each invariant: what it is, why, where, and the command that checks it (`references/invariants.md`). Holds `references/rules-map.tsv` |
| `security-model` | background | Trust boundaries and the rules at each; `references/checklist.md` per boundary |
| `testing` | background | Where a test goes, how the workerd suites work, the rules (golden values, fixtures, vitest pin) |
| `preflight` | model + `/` | The verify job's checks, scoped to what changed with `turbo --filter=...[origin/main]` |
| `add-node-type` | model + `/` | Spec, executor, icon, `ROLLBACKS`, event, tests, docs |
| `d1-migration` | model + `/` | Next number, expand-only SQL, `schema.ts`, local apply, migration tests, expand/contract |
| `infra-change` | model + `/` | `wrangler.jsonc` → types → `fleet.ts` → `provision.sh` → fleet tests, and rollout order |
| `ci-triage` | model + `/` | Classify a failed run and take the one safe next step |
| `review-change` | `/` only | Parallel code and security review plus mechanical checks, merged into one ranked list |
| `ship` | `/` only | Worktree → preflight → commit → push the branch → open the PR. Stops there |
| `docs-sync` | model + `/` | After a change: what's generated, what drifts, the procedure, the build |
| `docs-page` | model + `/` | Adding or moving a page: section, frontmatter, sidebar, components, voice |
| `docs-audit` | `/` only | A full page-by-page sweep |

`/` only means `disable-model-invocation: true`: these skills act on the repo (fan out agents,
push), so Claude runs them only when you ask.

## Hooks (`hooks/`, wired in `settings.json`)

| Event | Script | Behaviour |
|---|---|---|
| `SessionStart` | `session-context.sh` | Adds the branch, uncommitted count and whether this is a worktree. On `main` in the shared checkout, says to branch in a worktree instead of switching |
| `PreToolUse` (Bash) | `guard-bash.sh` | **Denies** `wrangler deploy` / `versions deploy` / `rollback` / `delete`, remote D1 migrations (`--remote`, `db:migrate:remote`), Time Travel restores, deleting D1, KV, R2 or queues, and `pnpm deploy` / `docs:deploy`. Catches them when chained after another command too. **Asks** before pushing `main` (named, `HEAD:main`, or a bare push on `main`), force or `+refspec` pushes, `gh pr merge`, `gh workflow run`, remote D1 SQL, `wrangler secret`, and `scripts/provision.sh` |
| `PreToolUse` (Edit/Write) | `block-generated.sh` | **Denies** hand edits to generated files: the docs `theme.css` and `worker-configuration.d.ts` |
| `PreToolUse` (Edit/Write) | `guard-invariants.sh` | **Denies** editing a migration already on `origin/main` (core or plugin), the vendored UCP schemas, and new text with a z-suffixed route (`/healthz`…). **Asks** before editing the routing golden test |
| `PostToolUse` (Edit/Write) | `format.sh` | Runs `biome check --write` on the edited file. Silent when clean; passes back errors Biome can't fix |
| `PostToolUse` (Edit/Write) | `docs-impact.sh` | Logs the edit for this session; names the docs pages for a documented surface, once per file. Advisory |
| `PostToolUse` (Edit/Write) | `rules-impact.sh` | Names the rules an edit to that path must keep (from `rules-map.tsv`), once per file. Advisory |
| `Stop` | `docs-drift.sh` | **Blocks once** per drift-set when this session changed documented surfaces, still uncommitted, and no docs |

All hooks are bash + `jq` (required: without it every hook is a silent no-op, and the session
start says so), fail open (exit 0, silent) on anything unexpected, and share
`lib.sh` (`field`, `deny`, `ask`, `context`, `once`, `repo_path`), except the older docs hooks,
which stand alone. The docs hooks keep their edit log per git root, so another session's
uncommitted work in a shared checkout never trips them. Edits made through Bash (`sed`,
heredocs) reach neither the edit log nor the Edit/Write guards. `guard-bash.sh` splits on
`; & |` without parsing quotes, so it errs toward asking.

## Two maps, one source of truth each

| Map | Read by | Rows |
|---|---|---|
| [`skills/docs-sync/references/surface-map.tsv`](skills/docs-sync/references/surface-map.tsv) | `docs-impact`, `docs-drift`, `docs-sync` | source regex → docs pages → `gen` or `prose` |
| [`skills/orderloop-conventions/references/rules-map.tsv`](skills/orderloop-conventions/references/rules-map.tsv) | `rules-impact`, `orderloop-conventions`, `review-change` | source regex → the rule to keep |

When you add a documented surface or a path-specific rule, add its row. Every matching row is
said, so keep regexes narrow.

## Permissions (`settings.json`)

- **Allow:** the checks (`pnpm lint`, `check-types`, `test`, `test:fleet`, `test:toolkit`,
  `turbo run`, each package's `test` and `types` by name, engine vitest projects), local
  D1, the docs build, `fleet.ts render`/`matrix`, read-only `gh run` and `gh pr`, and the toolkit
  tests.
- **Ask:** `git push`, `gh pr merge`, `gh run rerun`, `gh workflow run`, `scripts/provision.sh`.
- **Deny:** `pnpm deploy`, `pnpm run deploy`, `pnpm docs:deploy`, `wrangler deploy`,
  `wrangler rollback`, remote migrations. The hooks back these up for chained and filtered forms.

Personal settings (notifications, extra allows) go in `settings.local.json`, which is gitignored.

## Testing the toolkit

```bash
pnpm test:toolkit
```

This runs `.claude/scripts/toolkit-check.sh` (skill and agent frontmatter against the Agent Skills spec,
preloads that exist, hook scripts executable and parseable, map regexes that compile), then the
two hook suites in `hooks/tests/`. CI runs it in the verify job. Changes to `settings.json` take
effect in a new session; skills and agents reload on their own.

## Adding to the toolkit

- **A rule a machine can check** goes in a hook. Add a case to `guard-invariants.sh` or
  `guard-bash.sh`, with tests for deny, ask and allow in `hooks/tests/guard-hooks.test.sh`.
- **A rule that needs judgement** goes in `orderloop-conventions/references/invariants.md`,
  with a check command, and in `rules-map.tsv` if it's tied to a path.
- **A procedure** becomes a skill. Write the `description` as what plus when. Keep `SKILL.md`
  under 500 lines with detail in `references/`. Use `disable-model-invocation` if it acts on
  the repo.
- **A role** becomes an agent. Give it the fewest tools that do the job, preload its skills,
  and end its prompt with the output format the caller needs.
