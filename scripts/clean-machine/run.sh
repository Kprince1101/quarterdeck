#!/bin/sh
set -eu

repo="${1:-/repo}"
clone="$(mktemp -d)/quarterdeck"

cp -R "$repo" "$clone"
cd "$clone"
npm install --no-audit --no-fund
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/clean-machine/check.ts
