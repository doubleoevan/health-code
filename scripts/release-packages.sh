#!/usr/bin/env bash
set -euo pipefail

# Keep the npm token away from the build and test commands.
npm_token="${NPM_TOKEN:-}"
unset NPM_TOKEN

# Match the command workspace to the library release that ships it.
version=$(node -p 'require("./packages/health-code/package.json").version')
test "$version" = "$(node -p 'require("./apps/cli/package.json").version')"
test "$version" = "$(node -p 'require("./apps/cli/package.json").dependencies["health-code"]')"
artifacts=$(mktemp -d)
trap 'rm -rf "$artifacts"' EXIT

# Build and audit exactly the bytes intended for publication.
bun run --cwd packages/health-code prepack
npm pack ./packages/health-code --ignore-scripts --json --pack-destination "$artifacts" > "$artifacts/health-code.json"

# Require a README and only publishable artifacts in the tarball.
for name in health-code; do
  jq -e '.[0].files | any(.path=="README.md") and all(.path | test("(^|/)([.]env([.][^/]*)?|node_modules|fixtures|src|test)(/|$)")|not)' "$artifacts/$name.json" >/dev/null
done

# Exercise npm staging locally without making a registry change.
if [[ "${1:-}" == "--dry-run" ]]; then
  archive=$(jq -r '.[0].filename' "$artifacts/health-code.json")
  npm_config_offline=true npm stage publish --dry-run --provenance --ignore-scripts --access public "$artifacts/$archive"
  echo "The npm staging dry run passed."
  exit 0
fi

# Permit registry writes only for matching tags in the designated workflow.
test "${GITHUB_WORKFLOW_REF:-}" = "doubleoevan/health-code/.github/workflows/release.yml@refs/tags/v$version"
test "${GITHUB_REF:-}" = "refs/tags/v$version"
test "${GITHUB_ACTIONS:-}" = true

# Require an OIDC-enabled tag push for staging and a read-only run for verification.
if [[ "${1:-}" == "--stage" ]]; then
  test "${GITHUB_EVENT_NAME:-}" = push
  test -n "${ACTIONS_ID_TOKEN_REQUEST_URL:-}"
else
  test "${1:-}" = "--verify-public"
fi
test -z "${NODE_AUTH_TOKEN:-}"

# Accept a token only to stage.
[[ "$1" == "--stage" || -z "$npm_token" ]]
registry=https://registry.npmjs.org

pending=()

# Verify an already public release before staging the tarball.
for name in health-code; do
  manifest="$artifacts/$name.json"
  package=$(jq -r '.[0].name' "$manifest")
  archive=$(jq -r '.[0].filename' "$manifest")

  # Compare against the exact tarball audited above.
  digest=$(jq -r '.[0].integrity' "$manifest")
  endpoint="$registry/$(jq -nr --arg package "$package" '$package|@uri')/$version"
  status=$(curl --silent --show-error --output "$artifacts/registry.json" --write-out '%{http_code}' "$endpoint")

  # Resume only after checking any prior publication against this build.
  if [[ "$status" == 404 ]]; then
    if [[ "$1" == "--verify-public" ]]; then
      echo "$package@$version is awaiting maintainer approval on npmjs.com." >&2
      exit 1
    fi
    pending+=("$archive")
    continue
  fi

  # Reject registry failures and compare confirmed public bytes.
  test "$status" = 200
  test "$digest" = "$(jq -r .dist.integrity "$artifacts/registry.json")"

  # Verify the signed registry provenance before checking its workflow claims.
  proof=$(jq -er '.dist.attestations.url' "$artifacts/registry.json")
  [[ "$proof" == https://registry.npmjs.org/-/npm/v1/attestations/* ]]
  mkdir -p "$artifacts/verify"
  (cd "$artifacts/verify" && npm install --ignore-scripts --no-audit --registry="$registry" "$package@$version" && npm audit signatures --registry="$registry")
  curl --fail --silent --show-error "$proof" -o "$artifacts/proof.json"

  # Bind the attested workflow, Git ref and resolved commit to the checked-out tag.
  jq -er '.attestations[] | select(.predicateType=="https://slsa.dev/provenance/v1") | .bundle.dsseEnvelope.payload | @base64d | fromjson | .predicate.buildDefinition' "$artifacts/proof.json" > "$artifacts/build.json"
  jq -e --arg ref "$GITHUB_REF" --arg sha "$(git rev-parse HEAD)" '
    .externalParameters.workflow.path == ".github/workflows/release.yml"
    and .externalParameters.workflow.repository == "https://github.com/doubleoevan/health-code"
    and .externalParameters.workflow.ref == $ref
    and any(.resolvedDependencies[]; .digest.gitCommit==$sha)' "$artifacts/build.json" >/dev/null
done

# npm rejects this repository's trusted publishing sign-in (npm/cli#9969).
if [[ -n "$npm_token" ]]; then
  printf '%s\n' '//registry.npmjs.org/:_authToken=${NPM_TOKEN}' > "$artifacts/npmrc"
  export npm_config_userconfig="$artifacts/npmrc"
fi

# Stop after staging. The maintainer approves the version on npmjs.com.
for archive in "${pending[@]}"; do
  NPM_TOKEN="$npm_token" npm stage publish --registry="$registry" --provenance --access public "$artifacts/$archive"
done
