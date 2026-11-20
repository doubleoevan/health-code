#!/usr/bin/env bash
set -euo pipefail

bun run check:style
bun run check:structure
bun run check:boundaries
bun run check:pins
bun run check:unused
bun run typecheck
bun run test
bun run check:package

echo "preflight green"
