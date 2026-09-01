#!/usr/bin/env bash
#
# publish-to-new-repo.sh
# ----------------------
# Creates the GitHub repo sggr57a/Tdarr-Plugins and pushes the contents of THIS
# folder (tdarr-plugins/) as the ROOT of that new repo.
#
# Run this from YOUR machine (not the Cloud Agent), where you are authenticated
# to GitHub as sggr57a. The Cloud Agent's token is scoped to a single repo and
# cannot create new repositories.
#
# Prerequisites:
#   - GitHub CLI installed and logged in as sggr57a:  gh auth login
#     (needs the "repo" scope) OR a Personal Access Token with repo permissions.
#   - git installed.
#
# Usage:
#   cd tdarr-plugins
#   ./publish-to-new-repo.sh
#
# Options (env vars):
#   REPO=sggr57a/Tdarr-Plugins   Target repo (default)
#   VISIBILITY=public            public|private (default public)

set -euo pipefail

REPO="${REPO:-sggr57a/Tdarr-Plugins}"
VISIBILITY="${VISIBILITY:-public}"

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
echo "Publishing contents of: $SRC_DIR"
echo "Target repo:            $REPO ($VISIBILITY)"

command -v git >/dev/null 2>&1 || { echo "ERROR: git not found"; exit 1; }

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Copy everything except VCS noise and this script's own git history.
tar -C "$SRC_DIR" \
  --exclude='.git' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  -cf - . | tar -C "$STAGE" -xf -

cd "$STAGE"
git init -q
git checkout -q -b main
git add .
git -c user.name="${GIT_AUTHOR_NAME:-$(git config user.name || echo sggr57a)}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$(git config user.email || echo sggr57a@users.noreply.github.com)}" \
    commit -q -m "Initial commit: Tdarr AI upscaling & denoising plugins"

if command -v gh >/dev/null 2>&1; then
  echo "Creating repo with gh and pushing..."
  gh repo create "$REPO" --"$VISIBILITY" --source=. --remote=origin --push
else
  echo "gh CLI not found. Create the empty repo '$REPO' on GitHub first, then run:"
  echo "  git -C \"$STAGE\" remote add origin git@github.com:$REPO.git"
  echo "  git -C \"$STAGE\" push -u origin main"
  echo
  echo "Staged repo is ready at: $STAGE (not auto-deleted since manual step is needed)"
  trap - EXIT
fi

echo "Done."
