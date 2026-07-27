#!/usr/bin/env bash
set -euo pipefail

upstream_remote="${T3_FORK_UPSTREAM_REMOTE:-upstream}"
upstream_branch="${T3_FORK_UPSTREAM_BRANCH:-main}"
skip_verify=0

usage() {
  printf '%s\n' \
    "Usage: scripts/update-from-upstream.sh [--skip-verify]" \
    "" \
    "Safely merges ${upstream_remote}/${upstream_branch} into the current fork branch." \
    "The script requires a clean worktree and creates a backup branch before merging."
}

case "${1:-}" in
  "")
    ;;
  --skip-verify)
    skip_verify=1
    ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
  printf '%s\n' "Not inside a Git repository." >&2
  exit 1
fi
cd "$repo_root"

current_branch="$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
if [[ -z "$current_branch" ]]; then
  printf '%s\n' "Detached HEAD is not supported. Check out the fork branch first." >&2
  exit 1
fi
if [[ -n "$(git status --porcelain=v1)" ]]; then
  printf '%s\n' \
    "The worktree is not clean. Commit or stash your changes before updating." \
    "No fetch, merge, or branch was performed." >&2
  exit 1
fi
if ! git remote get-url "$upstream_remote" >/dev/null 2>&1; then
  printf '%s\n' \
    "Missing '$upstream_remote' remote." \
    "Add it with:" \
    "  git remote add $upstream_remote https://github.com/pingdotgg/t3code.git" >&2
  exit 1
fi

printf '%s\n' "Fetching ${upstream_remote}/${upstream_branch}..."
git fetch "$upstream_remote" "$upstream_branch" --tags
upstream_ref="${upstream_remote}/${upstream_branch}"

if git merge-base --is-ancestor "$upstream_ref" HEAD; then
  printf '%s\n' "Already up to date with ${upstream_ref}."
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
safe_branch="${current_branch//\//-}"
backup_branch="backup/${safe_branch}-${timestamp}"
git branch "$backup_branch" HEAD
printf '%s\n' "Created safety branch: ${backup_branch}"

if ! git merge --no-edit "$upstream_ref"; then
  printf '%s\n' "Merge conflict detected; aborting the merge." >&2
  git merge --abort
  printf '%s\n' \
    "Your branch is unchanged." \
    "Safety copy: ${backup_branch}" >&2
  exit 1
fi

if ! git diff --quiet "${backup_branch}..HEAD" -- pnpm-lock.yaml package.json pnpm-workspace.yaml; then
  printf '%s\n' "Dependency metadata changed; installing the locked workspace..."
  pnpm install --frozen-lockfile
fi

if [[ "$skip_verify" -eq 0 ]]; then
  printf '%s\n' "Validating the fork integration..."
  pnpm --filter @t3tools/contracts typecheck
  pnpm --filter @t3tools/client-runtime typecheck
  pnpm --filter t3 typecheck
  pnpm --filter @t3tools/web typecheck
  pnpm vp test run \
    apps/server/src/provider/acp/GenericAcpSupport.test.ts \
    apps/server/src/provider/Layers/ProviderService.test.ts \
    apps/web/src/components/settings/ImportProviderSessionsDialog.logic.test.ts
fi

printf '%s\n' \
  "Update complete on '${current_branch}'." \
  "Safety copy: ${backup_branch}" \
  "Review the merge, then push with: git push origin ${current_branch}"
