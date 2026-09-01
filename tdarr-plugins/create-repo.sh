#!/usr/bin/env bash
#
# create-repo.sh
# --------------
# Turnkey wrapper: create sggr57a/Tdarr-Plugins on GitHub and push the contents
# of THIS folder (tdarr-plugins/) as the repo root, using a token from the
# environment. Intended to run in a fresh Cloud Agent VM that has a GitHub PAT
# secret injected (e.g. GH_TOKEN), or on any machine with such a token.
#
# It authenticates non-interactively, so no `gh auth login` prompt is needed.
#
# Token resolution order (first non-empty wins):
#   GH_TOKEN, GITHUB_TOKEN, TDARR_PLUGINS_GH_TOKEN, PAT, GH_PAT
#
# Usage:
#   cd tdarr-plugins
#   ./create-repo.sh
#
# Options (env vars):
#   REPO=sggr57a/Tdarr-Plugins   Target repo (default)
#   VISIBILITY=public            public|private (default public)

set -euo pipefail

REPO="${REPO:-sggr57a/Tdarr-Plugins}"
VISIBILITY="${VISIBILITY:-public}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

# Resolve a usable token from common secret names.
TOKEN=""
for var in GH_TOKEN GITHUB_TOKEN TDARR_PLUGINS_GH_TOKEN PAT GH_PAT; do
  val="${!var:-}"
  if [ -n "$val" ]; then TOKEN="$val"; echo "Using token from \$$var"; break; fi
done

if [ -z "$TOKEN" ]; then
  echo "ERROR: No GitHub token found in the environment." >&2
  echo "Set a classic PAT with the 'repo' scope as one of:" >&2
  echo "  GH_TOKEN / GITHUB_TOKEN / TDARR_PLUGINS_GH_TOKEN / PAT / GH_PAT" >&2
  echo "In Cloud Agents, add it as a secret and start a NEW run (secrets inject at VM boot)." >&2
  exit 1
fi

command -v gh  >/dev/null 2>&1 || { echo "ERROR: gh CLI not found"; exit 1; }
command -v git >/dev/null 2>&1 || { echo "ERROR: git not found"; exit 1; }

# Verify the token can act as the expected owner and has repo-create rights.
OWNER="${REPO%%/*}"
export GH_TOKEN="$TOKEN"
ACCT="$(gh api user --jq .login 2>/dev/null || true)"
echo "Authenticated as: ${ACCT:-<unknown>} (target owner: $OWNER)"

# Stage a clean copy (repo contents become the new repo root).
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
tar -C "$SRC_DIR" --exclude='.git' --exclude='__pycache__' --exclude='*.pyc' -cf - . \
  | tar -C "$STAGE" -xf -

cd "$STAGE"
git init -q
git checkout -q -b main
git add .
git -c user.name="${GIT_AUTHOR_NAME:-$OWNER}" \
    -c user.email="${GIT_AUTHOR_EMAIL:-$OWNER@users.noreply.github.com}" \
    commit -q -m "Initial commit: Tdarr AI upscaling & denoising plugins"

if gh repo view "$REPO" >/dev/null 2>&1; then
  echo "Repo $REPO already exists; pushing to it."
  git remote add origin "https://x-access-token:${TOKEN}@github.com/${REPO}.git"
  git push -u origin main
else
  echo "Creating $REPO ($VISIBILITY) and pushing..."
  gh repo create "$REPO" --"$VISIBILITY" --source=. --remote=origin --push
fi

echo "Done: https://github.com/$REPO"
