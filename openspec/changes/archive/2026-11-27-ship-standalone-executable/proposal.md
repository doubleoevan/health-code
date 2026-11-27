# Proposal

## Why

Health Code's argument is that an upgrade's new code should not run next to your secrets. Yet `npx health-code check` resolves and installs about 200 packages at job time, in the job that holds `RUNTA_TOKEN` and often a token that can push. It also needs Node 22.18 or later, which a Bun, Go or Python pipeline does not have. CarlNotes' CI is the first caller: its workflow holds `RUNTA_TOKEN` and a write token, and its repository runs Bun, not Node. One executable built from the locked dependencies at release time removes both problems.

## What Changes

- Ship the `health-code` CLI as a standalone Bun executable for Linux x64, Linux arm64 and macOS arm64 on each GitHub release. It is a second build of the same CLI source, with the same commands, flags, output, exit codes and report files.
- Route every file the library reads from its own package at run time through one function and one list. The list covers `package.json`, the prompt templates and the Guest bundles. The npm package reads them from disk as today. The executable reads the same paths from its embedded copy.
- Add `health-code --version` to both builds. `--version --json` also prints the runtime and the SHA-256 digest of every package file. The tests and the release use it to prove that the executable and the npm package carry identical Guest bundles.
- Build the executable so that it never loads `.env` or `bunfig.toml` from the working directory, which in CI is the inspected checkout.
- Extend the tag workflow. One native runner per platform builds and tests its executable from the frozen lockfile. One publish job attests the files with SLSA build provenance and uploads them to the GitHub release with a checksum file and the Sigstore bundle. The npm staging job runs only after the executables are published. The publish job is the only job with `contents: write`.
- Add a composite GitHub Action at the repository root. It downloads the executable for the action's own release version, verifies the checksum and the build provenance, and puts `health-code` on `PATH`.
- Rewrite the CI guide to lead with the executable and the action. `npx` stays as the second way. The guide states that `--pull-request` still needs `git` and `gh` on the machine.
- Add offline tests of the built executable and a live parity check: one fixture inspection through the executable and through the npm CLI ends with the same Verdict.
- The npm package does not change. It keeps the same exports, bin, engines and published files.

## Capabilities

### New Capabilities

None. The executable is another way to install and run the existing CI command.

### Modified Capabilities

- `ci-inspections`: The command runs from the standalone executable with the same behavior as the npm CLI. It prints its version, never loads repository configuration on the CI machine and installs in GitHub Actions through a verifying action. Setup is named `health-code setup` without assuming npx.
- `package-releases`: A version tag also publishes the executables with checksums and build provenance. The executables and the npm package carry identical package files. A failed executable build stages no npm package. Release file uploads get the only write permission.

## Impact

- `packages/health-code/src/`: a new `readPackageFile.ts`. `readPrompt.ts`, `index.ts` and `sandbox/createSandboxProvider.ts` read through it. The public API is unchanged.
- `apps/cli/`: `--version` in `cli.ts` and the usage text, a `build:executable` script, executable tests and README and AGENTS.md updates.
- `scripts/`: an executable files check, a release-files check in `release-packages.sh` and a structure check that rejects package file reads outside `readPackageFile.ts`.
- `.github/workflows/release.yml`: build, publish and stage jobs in that order, with new permissions. Also `.github/AGENTS.md`.
- A new root `action.yml`, with rows in the root AGENTS.md map and the routing table.
- `.agents/skills/domain-model/SKILL.md`: add "Standalone executable".
- Release assets per version: three executables of about 75 MB each, `health-code-<version>.sha256` and `health-code-<version>.sigstore.json`.
- No new runtime dependency. The build uses the Bun version that `.bun-version` declares.
