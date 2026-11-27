# GitHub Action

The root `action.yml` is a composite action that installs the `health-code` standalone executable on a GitHub-hosted runner. `install-executable.sh` does the work.

## Behavior

1. Reads the version from the `version` input, or from `packages/health-code/package.json` at the action's own commit.
2. Maps `RUNNER_OS` and `RUNNER_ARCH` to `linux-x64`, `linux-arm64` or `darwin-arm64`. Any other runner fails with the npx command.
3. Downloads `health-code-<version>-<platform>` and `health-code-<version>.sha256` from the `doubleoevan/health-code` release into a private folder under `RUNNER_TEMP`.
4. Checks the checksum, then runs `gh attestation verify` against the release workflow and the version's tag on a GitHub-hosted runner. When a workflow references the action by commit SHA and sets no `version`, it also passes `--source-digest` with that SHA, so a tag moved to another commit fails.
5. Runs `--version` to confirm the version, then moves the file to `$RUNNER_TEMP/health-code/bin/health-code` and adds that folder to `GITHUB_PATH`.

A failed step leaves nothing on `PATH`. The `token` input defaults to `github.token` and only reads releases and attestations.

The action holds no checksum of its own. The release workflow builds the executables after the tag exists, and the attestation binds each file to that workflow and tag. Dependabot's `github-actions` updates in `../.github/dependabot.yml` cover a workflow that uses the action by commit SHA.

## Verification

`../scripts/installExecutable.test.ts` runs the script against `../scripts/fixtures/stub-gh.sh` and a stub release: a good install, the commit check, a checksum mismatch, a failed attestation, an unsupported runner and a missing release. Run it with `bun test ./scripts/installExecutable.test.ts`. The release workflow's own `verify-public` job runs the same checksum and attestation commands against a published release.
