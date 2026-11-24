#!/usr/bin/env bash
set -euo pipefail

# Include new manifests before they reach the index.
paths=$(git ls-files --cached --others --exclude-standard -- 'package.json' '*/package.json' ':!.agents/**' ':!.claude/**' ':(exclude,glob)**/fixtures/recorded/**')
status=0

# report every manifest outside a supported workspace
while IFS= read -r path; do
  if [[ -f "$path" && ! "$path" =~ ^(package\.json|(apps|packages)/[^/]+/package\.json)$ ]]; then
    echo "$path: place package manifests at the root or directly in a workspace" >&2
    status=1
  fi
done <<< "$paths"
exit "$status"
