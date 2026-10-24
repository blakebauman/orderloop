#!/bin/bash
# SessionStart: tells Claude where it is (the branch, uncommitted work, whether this is a worktree)
# before it does anything. The main checkout is shared between sessions that switch branches, so
# when it sits on main the advice is to branch in a worktree rather than switch it. Local git only,
# no network. Fails open.
. "$(dirname "$0")/lib.sh"
dir=${CLAUDE_PROJECT_DIR:-$(field .cwd)}
top=$(git -C "${dir:-.}" rev-parse --show-toplevel 2>/dev/null) || exit 0
branch=$(git -C "$top" branch --show-current 2>/dev/null)
dirty=$(git -C "$top" status --porcelain 2>/dev/null | grep -c .)
worktree=no
[ "$(git -C "$top" rev-parse --git-dir)" != "$(git -C "$top" rev-parse --git-common-dir)" ] && worktree=yes

msg="Order Loop session: branch \`${branch:-detached}\`, $dirty uncommitted path(s), worktree: $worktree."
if [ "$branch" = main ] && [ "$worktree" = no ]; then
  msg+=" This checkout is shared with other sessions: don't switch its branch. For branch work, create a git worktree (\`git worktree add ../orderloop-<topic> -b <branch> origin/main\`) and open the PR with \`gh pr create --head <branch>\`."
fi
msg+=" Toolkit: agents engineer, test-engineer, code-reviewer, security-reviewer, devops, dx-reviewer, docs-sync; /review-change before a PR, /ship to open one. Deploys happen only in CI."
context SessionStart "$msg"
