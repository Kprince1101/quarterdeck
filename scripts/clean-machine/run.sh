#!/bin/sh
set -eu

repo="${1:-/repo}"
clone="$(mktemp -d)/quarterdeck"

if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends git ca-certificates >/dev/null
fi
git -c safe.directory='*' clone --quiet --no-local "$repo" "$clone"
cd "$clone"
git log -1 --format='Cloned %H'
node --version
npm install --no-audit --no-fund
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/clean-machine/check.ts
