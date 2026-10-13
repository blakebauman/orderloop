# Order Loop Claude Code toolkit

Project-scoped agents, skills and hooks for this repo, version-controlled and reviewed like source.
Today the toolkit has one job: keeping the docs site (`apps/docs`) in sync with the code.

## How the docs stay in sync

1. **Generated reference pages.** The node catalog, the built-in flows, the node→event table, every
   status and event list, and the OpenAPI explorer render from `@orderloop/core` and
   `apps/web/app/lib/openapi.ts` at build time. Rebuilding refreshes them.
2. **A build that fails loudly.** `pnpm docs:build` rejects unknown sidebar slugs and broken
   imports, and `apps/docs/scripts/check-links.mjs` fails on any internal link or anchor that
   doesn't resolve.
3. **Hooks that notice.** Editing a documented file names the pages that describe it; ending a turn
   with documented code changed and no docs touched blocks once and asks for a sync.
4. **An agent and skills that do the prose.** The `docs-sync` agent and skill map a change to its
   pages and verify every claim against the source.

The map from source files to pages is one file,
[`skills/docs-sync/references/surface-map.tsv`](skills/docs-sync/references/surface-map.tsv),
read by both hooks and the skill. When you add a docs page or a documented surface, add its row.

## Subagents (`agents/`)

| Agent | Use it for |
|---|---|
| `docs-sync` | Mapping a change to MDX pages, verifying claims against the source, editing prose, rebuilding. Never edits runtime code or deploys |

## Skills (`skills/`)

Written to the [Agent Skills](https://agentskills.io/specification) format. Invoke with `/<name>`,
or let Claude pick them by description.

| Skill | Use it for |
|---|---|
| `docs-sync` | After a change: what's generated, what drifts, the procedure, the build |
| `docs-page` | Adding or moving a page: section, frontmatter, sidebar, components, voice |
| `docs-audit` | A full page-by-page sweep. Manual only (`disable-model-invocation`) |

## Hooks (`hooks/`, wired in `settings.json`)

| Event | Script | Behaviour |
|---|---|---|
| `PostToolUse` (Edit/Write) | `docs-impact.sh` | Logs the edited file for this session, and names the docs pages for an edited surface, once per file per session. Advisory |
| `Stop` | `docs-drift.sh` | **Blocks once** per drift-set when files *this session* edited are documented surfaces, still uncommitted, and this session edited nothing under `apps/docs/` |

The Stop hook only counts files in the session's edit log, kept per git root, so another session's
uncommitted work in a shared checkout never trips it, and edits inside a git worktree are checked
against that worktree. Edits made through Bash (`sed`, heredocs) don't reach the log and aren't
counted; the hook fails open.

Both use `docs-map.sh` to read the surface map. They fail open (exit 0) and stay silent when there
is nothing to say. Test them with:

```bash
.claude/hooks/tests/docs-hooks.test.sh
```

Editing `settings.json` takes effect in a new session; skills and agents reload on their own.

## Permissions

`settings.json` allows the docs build, lint and type-check, and **asks** before a docs deploy.
