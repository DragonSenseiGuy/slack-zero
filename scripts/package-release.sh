#!/usr/bin/env bash
#
# Build the downloadable release: `npm run package:release`
#
# Produces dist/slackzero-v<version>.zip from the *committed* tree, via
# `git archive` — so the artifact cannot accidentally carry `.env`,
# `node_modules`, a stale `.next`, or anything else untracked. Uncommitted
# changes are not in it; commit first.
#
# What the reviewer does with it:
#   unzip slackzero-v<version>.zip && cd slackzero-v<version>
#   docker compose -f docker-compose.demo.yml up --build
#   open http://localhost:7001
set -euo pipefail

VERSION="$(node -p "require('./package.json').version")"
NAME="slackzero-v${VERSION}"
OUT="dist/${NAME}.zip"

if [ -n "$(git status --porcelain)" ]; then
  echo "warning: uncommitted changes are NOT included in the archive." >&2
fi

mkdir -p dist
rm -f "${OUT}"
git archive --format=zip --prefix="${NAME}/" -o "${OUT}" HEAD

echo "Wrote ${OUT} ($(du -h "${OUT}" | cut -f1))"
echo
echo "Publish it with:"
echo "  gh release create v${VERSION} ${OUT} --title \"SlackZero v${VERSION}\" --notes-file RELEASE.md"
