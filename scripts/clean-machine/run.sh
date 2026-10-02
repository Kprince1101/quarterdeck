#!/bin/sh
set -eu

packs="${1:-/packs}"
repo="${2:-/repo}"
app="$(mktemp -d)"

cd "$app"
npm init --yes >/dev/null
npm pkg set type=module
npm install --no-audit --no-fund "$packs"/*.tgz
cp -R "$repo/packages/server/test/acp/fake-agent" ./fake-agent
cp "$repo/scripts/clean-machine/check.ts" ./check.ts
node --experimental-strip-types --disable-warning=ExperimentalWarning check.ts
