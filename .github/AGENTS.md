# GitHub automation

`workflows/` contains CI and CodeQL. CI runs the offline preflight and the separate dependency advisory check. `actions/setup-bun/` installs the declared Bun version and frozen workspace dependencies. `dependabot.yml` schedules dependency updates for Bun and GitHub Actions.

Update this guide and DEVELOPMENT.md when a workflow changes the commands contributors use.

Manually dispatch `workflows/evaluations.yml` to score a case using CI secrets. See `../evals/AGENTS.md` for local record mode and review.

On a matching version tag, `workflows/release.yml` runs these jobs in order:

| Job | Runs on | Permissions | Does |
| --- | --- | --- | --- |
| `verify` | Linux x64 | `contents: read` | Checks the tag against main and runs preflight. |
| `build-executable` | Linux x64, Linux arm64, macOS arm64 | `contents: read` | Runs `bun run test:executable` and uploads `health-code-<version>-<platform>` with its `.files.json` digests. |
| `publish-executables` | Linux x64 | `contents: write`, `id-token: write`, `attestations: write`, `artifact-metadata: write` | Requires identical digests from every platform, writes `health-code-<version>.sha256`, attests the executables and publishes them with `health-code-<version>.sigstore.json` on the GitHub release. It checks out no code. |
| `stage` | Linux x64 | `contents: read`, `id-token: write` | Compares the npm tarball's package files with the executables' digests and stages it through `scripts/release-packages.sh --stage`. |

`publish-executables` is the only job that can write to the repository, and `stage` is the only job that sees `NPM_TOKEN`. `scripts/releaseWorkflow.test.ts` checks both. A failed executable build stages no npm package. A rerun verifies executables an earlier run published against the run's commit and never replaces them. A failed release lookup other than a missing release stops the job. Turn on immutable releases in the repository settings so a published release's files and tag cannot change.

The maintainer approves each version on npmjs.com. A manual run of the workflow against the tag runs `verify-public`, which checks the published Linux x64 executable's checksum and its attestation against the tag's commit and compares its package files with the public npm tarball.
