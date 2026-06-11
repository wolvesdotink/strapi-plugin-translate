#!/usr/bin/env bash
#
# Cut a new release: bump the version, commit, tag, and push to GitHub.
# Pushing the vX.Y.Z tag triggers .github/workflows/release.yml, which builds,
# verifies, tests, publishes the package to npm, and creates the GitHub Release.
#
# Usage:
#   ./scripts/release.sh patch        # 0.1.0 -> 0.1.1
#   ./scripts/release.sh minor        # 0.1.0 -> 0.2.0
#   ./scripts/release.sh major        # 0.1.0 -> 1.0.0
#   ./scripts/release.sh 1.4.2        # set an explicit version
#
# Options (env vars):
#   SKIP_CHECKS=1   skip the local build + verify + test gate before tagging
#
set -euo pipefail

RELEASE_BRANCH="main"

bump="${1:-}"
if [[ -z "$bump" ]]; then
  echo "Usage: $0 <patch|minor|major|x.y.z>" >&2
  exit 1
fi

# --- Pre-flight checks -------------------------------------------------------
current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$RELEASE_BRANCH" ]]; then
  echo "error: releases must be cut from '$RELEASE_BRANCH' (you are on '$current_branch')." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree is not clean. Commit or stash your changes first." >&2
  git status --short >&2
  exit 1
fi

echo "==> Syncing with origin/$RELEASE_BRANCH"
git fetch origin "$RELEASE_BRANCH"
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "origin/$RELEASE_BRANCH")" ]]; then
  echo "error: local '$RELEASE_BRANCH' is not in sync with 'origin/$RELEASE_BRANCH'. Pull/push first." >&2
  exit 1
fi

# --- Local quality gate (build + verify + test) ------------------------------
if [[ "${SKIP_CHECKS:-0}" != "1" ]]; then
  echo "==> Running build, verify, and tests (set SKIP_CHECKS=1 to skip)"
  npm run build
  npm run verify
  npm test
else
  echo "==> SKIP_CHECKS=1: skipping local build/test gate"
fi

# --- Bump version (creates commit + tag) -------------------------------------
echo "==> Bumping version ($bump)"
# `npm version` updates package.json + package-lock.json, commits, and creates a
# git tag (vX.Y.Z). It fails if the resulting tag already exists.
new_tag="$(npm version "$bump" -m "Release v%s")"   # prints e.g. "v0.2.0"
new_version="${new_tag#v}"
echo "    -> $new_tag"

# --- Push commit + tag (this triggers the publish workflow) ------------------
echo "==> Pushing commit and tag to origin"
git push --follow-tags origin "$RELEASE_BRANCH"

echo
echo "✅ Pushed $new_tag."
echo "   The 'Release' workflow is now building, publishing"
echo "   @wolvesdotink/strapi-plugin-translate@$new_version to npm, and creating the GitHub Release."
if command -v gh >/dev/null 2>&1; then
  echo "   Watch it:  gh run watch \$(gh run list --workflow=release.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
fi
