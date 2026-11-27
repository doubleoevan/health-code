# Tasks

Follow AGENTS.md and the skills its routing table names for each module: domain-model and code-style throughout, write-docs for prose and git-discipline for the commit. Run `bash scripts/preflight.sh` before handoff.

## 1. One reader for package files

- [x] 1.1 Create `packages/health-code/src/readPackageFile.ts` with `packageFiles`, `PackageFile` and `readPackageFile` as in design decision 1. Detect the compiled program through `Bun.isStandaloneExecutable` with a narrow type for `globalThis.Bun`, so the Node build compiles without Bun types. Verify with a unit test that reads every listed path from the workspace and that `packageFiles` matches the prompt templates in `prompts/` other than `AGENTS.md` and the five Guest bundles named in the build script.
- [x] 1.2 Read `package.json` in `src/index.ts`, the templates in `src/readPrompt.ts` and the Guest bundles in `src/sandbox/createSandboxProvider.ts` through `readPackageFile`. Type the Guest bundle names as `PackageFile` paths. Verify `prompts.test.ts`, the provider tests and `bun run check:package` pass unchanged.
- [x] 1.3 Export `readPackageFileDigests()` from the public entry. Validate the templates through the existing `readTemplate` path and throw an `InspectionError` that names the first missing or invalid file. Verify with tests for a complete package, a missing Guest bundle and a template with an extra placeholder, using a temporary copy of the package.
- [x] 1.4 Add a rule to `scripts/check-structure.sh` that fails when a non-test file in `packages/health-code/src` other than `readPackageFile.ts` passes `import.meta.url` to a file read. Verify the rule passes on the tree and fails on a temporary file that reads `../prompts/repair.md` directly.
- [x] 1.5 Update `packages/health-code/AGENTS.md`, `src/AGENTS.md` and `GUIDE.md` for `readPackageFile.ts` and the new export. Verify every path those guides name exists.

## 2. Version command

- [x] 2.1 Add `--version` and `--version --json` to `apps/cli/src/cli.ts` as in design decision 3, before any settings are read. Add the `health-code --version` line to the usage text. Verify with CLI tests for each form's output, for exit code 1 with the file's name when `readPackageFileDigests()` throws and for no network request or settings read.
- [x] 2.2 Update `apps/cli/AGENTS.md` and the command table in `apps/cli/README.md` for `--version`. Verify the documented commands print what the guide shows.

## 3. Executable build

- [x] 3.1 Create `apps/cli/executable/buildExecutable.ts` and the `build:executable` script per design decision 2: stage the listed files, compile with the four autoload flags off and no minify, bytecode or sourcemap, write `build/health-code-<version>-<platform>` and its `.files.json`. Confirm `build/` is ignored. Verify the script builds on this machine and prints the executable's path and size.
- [x] 3.2 Make the build fail when the executable's `--version --json` digests differ from the staged files, and when its size exceeds the Bun runtime's by more than 15 MB. Verify each failure with unit tests in `apps/cli/executable/checkExecutable.test.ts`: a missing prompt, a changed Guest bundle, an extra file and an executable 20 MB over the runtime.
- [x] 3.3 Add a root `test:executable` script that builds the library, the CLI and the executable, then runs `bun test ./apps/cli/executable/executable.test.ts`. Write that test per design decision 10: version and usage, missing settings and bad arguments compared with the npm CLI's stdout, stderr and exit codes, all 13 digests against the workspace files, and a working directory whose `bunfig.toml` preloads a marker script and whose `.env` sets `HEALTH_CODE_MODEL`. Skip the test when no host executable exists. Verify `bun run test:executable` passes and `bun run test` skips it in a clean checkout.
- [x] 3.4 Add "Standalone executable" to `.agents/skills/domain-model/SKILL.md`. Update `apps/cli/AGENTS.md` and `DEVELOPMENT.md` with the build and test commands. Verify `bun run build:executable` and `bun run test:executable` run as documented.

## 4. Live parity

- [x] 4.1 Choose the named upgrade for the fixture Repository and commit in `packages/health-code/test/providerContract.ts`, one that passes its checks, and record it in the live test. Verify with one npm CLI run under `--upgrade-only` that the Verdict comes from the checks with no repair.
- [x] 4.2 Create `apps/cli/executable/executable.live.ts` and a `test:executable:live` script. Run the fixture through the npm CLI and the executable and compare the Verdicts and check statuses. Skip unless `RUNTA_TOKEN` and the model settings are set. Verify one passing run and record its duration in `design.md`.
- [x] 4.3 Add the SIGTERM and SIGINT cases from design decision 8: signal the executable after the log shows the sandbox, then assert exit code 1 and that Runta lists no sandbox with the Inspection's name prefix. Verify both cases pass live.
- [x] 4.4 Add the `--pull-request` case: a temporary checkout with a local bare remote, a `gh` stub on `PATH` that records its arguments and a `pre-push` hook that writes a marker. Verify the branch reaches the remote, the stub received the pull request call and the marker is absent.
- [x] 4.5 Record what the live run showed about Bun's `ws` and the `Authorization` header under "Verify during implementation" in `design.md`. Document `test:executable:live` in `apps/cli/AGENTS.md` and `DEVELOPMENT.md`.

## 5. Release workflow

- [x] 5.1 Look up the current commit SHAs and inputs of `actions/upload-artifact`, `actions/download-artifact` and `actions/attest-build-provenance`, and confirm that `ubuntu-24.04-arm` is available and `macos-latest` is arm64. Record the findings under "Verify during implementation" in `design.md`.
- [x] 5.2 Add the `build-executable` matrix job to `release.yml` with `contents: read`. Each leg runs the shared Bun setup, runs `bun run test:executable`, which builds the library, the CLI and the executable, and uploads the executable and its `.files.json`. Verify the job's permissions with `scripts/releaseWorkflow.test.ts`. The first tagged release verifies the upload on each runner in `verify-first-executable-release`.
- [x] 5.3 Add the `publish-executables` job per design decisions 5 and 6. It checks out nothing, requires identical `.files.json` files, writes the checksum file, attests through `subject-checksums`, uploads the Sigstore bundle, and creates a draft release, uploads the five files and publishes. On a rerun it verifies existing files against the run's commit and skips the upload. Verify the job holds the only `contents: write` grant with `scripts/releaseWorkflow.test.ts`. The first tagged release verifies the publication and the rerun in `verify-first-executable-release`.
- [x] 5.4 Make `stage` need `publish-executables`. In `release-packages.sh`, compare the packed tarball's 13 files with the `.files.json` digests before staging. In `--verify-public`, download the release's Linux x64 executable, run the checksum and attestation commands and compare its `--version --json` with the public tarball. Verify `release-packages.sh --dry-run` with a matching and a changed `.files.json`.
- [x] 5.5 Update `.github/AGENTS.md`, `DEVELOPMENT.md` and the root AGENTS.md CI row for the new jobs, the release files, the permissions and the immutable releases recommendation. Verify each named job and file exists in `release.yml`.

## 6. GitHub Action

- [x] 6.1 Create the root `action.yml`, `action/install-executable.sh` and `action/AGENTS.md` per design decision 7. Verify with a `bun test` that runs the script against a stub `gh` and stub release files: a good download, a checksum mismatch, a failed attestation, an unsupported runner and a missing release. Each failure leaves nothing on `PATH` and names its cause.
- [x] 6.2 Add `action/` and `action.yml` to the root AGENTS.md module map and routing table, and confirm `dependabot.yml` needs no change. Verify `bash scripts/check-structure.sh` accepts the new folder.

## 7. CI guide

- [x] 7.1 Rewrite `apps/cli/README.md` per design decision 10: the action first, then the manual download with checksum and attestation commands for one exact version, then npx with Node 22.18 or later. Say that the executable needs only `git` and `gh` for `--pull-request`, and add the macOS quarantine note. Update the weekly workflow example to use the action. Verify the guide avoids "pin" and that a failed check in the manual commands installs nothing. The first tagged release runs the manual commands in `verify-first-executable-release`.
- [x] 7.2 Update the root README's CI quick start and `packages/health-code/README.md` where they describe running the CI command. Verify every link and command in both resolves.

## 8. Integration

- [x] 8.1 Run `bash scripts/preflight.sh`, `bun run test:executable` and `bun run test:executable:live`. Verify all three pass.
- [x] 8.2 Move the checks that need the first tagged release into the `verify-first-executable-release` change: the action on Linux x64, Linux arm64 and macOS arm64, the manual verification commands, the Linux executable sizes and the quarantine result.

## Workflow follow-up

- Run `/ship` and complete its review.
- Archive the change with the OpenSpec CLI and commit the implementation and archive together on `main` after approval.
- Push to `origin/main` only with separate approval.
- Ask the maintainer to turn on immutable releases in the repository settings before the first release with executables.
