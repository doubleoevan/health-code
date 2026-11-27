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

`workflows/dependency-pull-requests.yml` is the reusable workflow other repositories call for their Renovate and Dependabot pull requests. Its `select` job installs the executable and decides from the event with a read-only token and no secret. Its `inspect` job is the only one that holds `RUNTA_TOKEN` and write permissions: it claims the Inspection mark, runs the check, saves the report and comments. Neither job checks out a pull request, and no run step holds a workflow expression. Both install the executable by checking out the workflow's own source at `job.workflow_sha` and running `action/install-executable.sh`. A call from another repository requires the build of that commit. A call by local path installs the release the commit's package version names. `scripts/dependencyPullRequestsWorkflow.test.ts` fails when either file breaks a rule, and when the CI guide's caller and this repository's caller differ.

`workflows/health-code.yml` is this repository's caller for its own Dependabot pull requests. It calls the reusable workflow by local path and passes `RUNTA_TOKEN` and the model settings only. `dependabot.yml` opens each major alone and groups minor and patch updates, so a major starts an inspection when it opens and a grouped pull request starts one only when it holds one package and CI fails. The maintainer sets it up by hand:

1. Add the repository variable `HEALTH_CODE_DEPENDENCY_PULL_REQUESTS` with the value `off` before the caller reaches `main`, and delete it after the first release that ships the workflow's commands.
2. Add `RUNTA_TOKEN` as a Dependabot secret with the same value as the Actions secret.
3. Run `npx health-code setup` once for `https://api.anthropic.com` with that Runta account.
4. Turn on **Allow GitHub Actions to create and approve pull requests** under Settings, Actions, General.
5. Create the `health-code` label.

The maintainer approves each version on npmjs.com. A manual run of the workflow against the tag runs `verify-public`, which checks the published Linux x64 executable's checksum and its attestation against the tag's commit and compares its package files with the public npm tarball.
