---
name: ship
description: Take finished work in Order Loop from a working tree to an open pull request. Checks the branch and worktree, runs preflight, commits with the attribution trailer, confirms an existing PR is still open before pushing to it, pushes the branch and opens the PR. Never merges or deploys. Use when the user says ship it, open a PR, or push this.
license: MIT
argument-hint: "[branch-name]"
disable-model-invocation: true
allowed-tools: Bash(git status *) Bash(git diff *) Bash(git log *) Bash(git branch *) Bash(git worktree list) Bash(gh pr view *) Bash(gh pr list *)
metadata:
  repo: orderloop
---

# Ship a change as a PR

Merging to `main` deploys to every customer, so this skill stops at an open PR. It never merges,
never pushes `main`, never deploys.

## Where you are

!`git branch --show-current`

!`git status --short`

!`git worktree list`

## Steps

1. **Branch and worktree.** The main checkout is shared by sessions that switch branches, so
   branch work happens in a git worktree.
   - On `main` in the main checkout: don't switch it. Create a worktree from `origin/main` with
     a branch named `$ARGUMENTS` or `<type>/<topic>` (`feat/…`, `fix/…`, `docs/…`, `chore/…`),
     `git worktree add ../orderloop-<topic> -b <branch> origin/main`, move the change there
     (commit nothing on `main`), and continue in it.
   - Already on a feature branch in a worktree: continue.
2. **Is there already a PR?** `gh pr list --head <branch> --state all`. If its PR is **merged or
   closed**, pushing more commits to the branch orphans them: start a new branch from
   `origin/main` and cherry-pick instead.
3. **Preflight.** Run the `preflight` skill. Don't ship red; if a failure isn't caused by this
   change, say so and ask the user.
4. **Docs.** If the change touched a documented surface and no docs, run `docs-sync` (the Stop
   hook will ask anyway).
5. **Commit.** Stage only this change's files by name (never `git add -A` in a shared tree).
   Message: a short imperative subject (as in `git log --oneline`: "Build listing indexes and
   serve category listings"), a body saying why, then a blank line and the attribution trailer
   from the system prompt.
6. **Push** the branch: `git push -u origin <branch>` (the `guard-bash` hook asks before
   anything that touches `main` or force-pushes).
7. **Open the PR:** `gh pr create --head <branch> --base main --title … --body …`. The body says
   what changed and why, how it was verified (the preflight commands and results), any rollout
   step that must happen before merge (provisioning, a contract migration that follows), and ends
   with the PR attribution line from the system prompt.
8. **Report** the PR URL and anything the user must do before merging. Stop there.
