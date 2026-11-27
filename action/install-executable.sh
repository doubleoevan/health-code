#!/usr/bin/env bash
set -euo pipefail

# Default to the release version of the source's own commit. A workflow or another action names its checkout.
repository=doubleoevan/health-code
source_path="${HEALTH_CODE_SOURCE_PATH:-${GITHUB_ACTION_PATH:?}}"
version="${HEALTH_CODE_VERSION:-}"
if [[ -z "$version" ]]; then
  version=$(jq -r .version "$source_path/packages/health-code/package.json")
fi

# Reject a version that is not a release number.
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "::error::\"$version\" is not a Health Code release version such as 0.4.0." >&2
  exit 1
fi

# Map the runner to a released platform.
case "${RUNNER_OS:-}/${RUNNER_ARCH:-}" in
  Linux/X64) platform=linux-x64 ;;
  Linux/ARM64) platform=linux-arm64 ;;
  macOS/ARM64) platform=darwin-arm64 ;;

  # point every other runner to the npm package
  *)
    echo "::error::Health Code ships executables for Linux x64, Linux arm64 and macOS arm64. On this runner, run npx health-code@$version with Node 22.18 or later." >&2
    exit 1
    ;;
esac

# Download into a private folder that never reaches PATH.
executable="health-code-$version-$platform"
checksums="health-code-$version.sha256"
download=$(mktemp -d "${RUNNER_TEMP:?}/health-code-download.XXXXXX")
trap 'rm -rf "$download"' EXIT
if ! gh release download "v$version" --repo "$repository" --dir "$download" --pattern "$executable" --pattern "$checksums"; then
  echo "::error::Release v$version of $repository has no $executable or $checksums." >&2
  exit 1
fi

# Compare the download with the release checksum.
expected=$(awk -v name="$executable" '$2 == name || $2 == "*" name { print $1 }' "$download/$checksums")
actual=$(cd "$download" && shasum -a 256 "$executable" | awk '{ print $1 }')
if [[ -z "$expected" || "$expected" != "$actual" ]]; then
  echo "::error::$executable does not match the checksum in $checksums." >&2
  exit 1
fi

# Require the build from the action's own commit when a workflow references the action by commit and names no version.
source_digest=()
action_ref="${HEALTH_CODE_ACTION_REF:-}"
if [[ -z "${HEALTH_CODE_VERSION:-}" && "$action_ref" =~ ^[0-9a-f]{40}$ ]]; then
  source_digest=(--source-digest "$action_ref")
fi

# Stop when a caller requires the commit check and names no commit.
if [[ "${HEALTH_CODE_SOURCE_DIGEST_REQUIRED:-}" == true && ${#source_digest[@]} -eq 0 ]]; then
  echo "::error::The workflow's own commit is unknown, so the executable's build cannot be checked against it." >&2
  exit 1
fi

# Require build provenance from the release workflow at this version's tag.
if ! gh attestation verify "$download/$executable" --repo "$repository" \
  --signer-workflow "$repository/.github/workflows/release.yml" \
  --source-ref "refs/tags/v$version" ${source_digest[@]+"${source_digest[@]}"} --deny-self-hosted-runners; then
  echo "::error::$executable has no build provenance from $repository's release workflow at v$version${action_ref:+ and commit $action_ref}. Reference the action at the release's commit or set the version input." >&2
  exit 1
fi

# Confirm the executable runs and reports the requested version.
chmod +x "$download/$executable"
reported=$("$download/$executable" --version)
if [[ "$reported" != "health-code $version" ]]; then
  echo "::error::$executable reported \"$reported\" instead of health-code $version." >&2
  exit 1
fi

# Put the verified executable on PATH for later steps.
bin="$RUNNER_TEMP/health-code/bin"
mkdir -p "$bin"
mv "$download/$executable" "$bin/health-code"
echo "$bin" >> "${GITHUB_PATH:?}"
echo "Installed $reported from $repository."
