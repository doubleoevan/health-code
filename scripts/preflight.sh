#!/usr/bin/env bash
set -euo pipefail

# check source comments and formatting before the build
bash scripts/check-comment-groups.sh --tracked
bun run check:style
bun run check:structure
bun run check:boundaries
bun run check:declared-versions
bun run check:unused

# verify the workspace and the packed consumer
bun run typecheck
bun run test
bun run check:package

echo "preflight green"
