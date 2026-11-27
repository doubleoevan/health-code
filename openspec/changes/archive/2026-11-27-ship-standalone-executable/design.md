# Design

This design records ten decisions for approval before any code changes. Decisions 1 to 3 cover the build: how package files resolve, how the executable is compiled and what `--version` prints. Decisions 4 to 7 cover the release: platforms, the workflow, provenance and the GitHub Action. Decisions 8 to 10 cover runtime parity, size and start time, and the docs. Each decision states the choice, the reason and the alternatives it rejects. Section "Verify during implementation" lists the facts the research could not confirm.

## Context

See `proposal.md` for the motivation. The facts below shape the approach. All measurements come from this checkout on macOS arm64 with Bun 1.4.3. `.bun-version` declares 1.4.4.

**Runtime file reads today.** The library reads three kinds of file from its own package, each relative to the reading module's `import.meta.url`:

| Reader | Path | When |
| --- | --- | --- |
| `src/index.ts` | `../package.json` | At import, for `libraryVersion` |
| `src/readPrompt.ts` | `../prompts/<name>.md` for seven templates | When `InspectionPrompts` is built and on first use of the investigation and credential probe templates |
| `src/sandbox/createSandboxProvider.ts` | `../../dist/<name>.mjs` for five Guest bundles | In `prepareRepository`, before upload |

No other library or CLI module reads its own package at run time. The CLI reads only the output folder and the personal allocation records under the user's home.

**What a compiled program sees.** A trial compile of `apps/cli/src/cli.ts` fails at start with `ENOENT: no such file or directory, open '/$bunfs/package.json'`. Every bundled module shares one `import.meta.url`, `file:///$bunfs/root/<executable name>`, so `../` points outside the embedded root. A probe confirmed three more facts:

- `--asset=<folder>` embeds the folder under `/$bunfs/root/<folder name>/`.
- `--asset=<file>` embeds the file at `/$bunfs/root/<file name>` and drops its folder.
- `Bun.isStandaloneExecutable` is `true` in the compiled program and `false` under `bun` and `bun test`.

**Defaults that matter in CI.** A compiled program loads `.env` and `bunfig.toml` from its working directory unless it is built with `--no-compile-autoload-dotenv` and `--no-compile-autoload-bunfig`. In CI the working directory is the inspected checkout. A `bunfig.toml` there can name a preload script. Bun's docs say these defaults may change in a later version. `tsconfig.json` and `package.json` autoloading are off by default.

**Runtime today.** `bun test` already runs the library and CLI unit tests on Bun's runtime. The npm CLI runs on Node, and only `check:package` exercises the packed library on Node. The Runta SDK opens the sandbox command stream with the `ws` package, passing an `Authorization` header and listening for `message`, `error` and `close`. Bun replaces `ws` with its own implementation. Model, GitHub and registry requests use `fetch`. `openPullRequest.ts` runs `git` and `gh` through `execFile` with `-c core.hooksPath=/dev/null`. The compile implies `--production`, which defines `process.env.NODE_ENV` as `"production"`. The only reader in the bundle is the AI SDK's gateway error text, which Health Code never reaches.

**Release today.** `release.yml` runs `verify`, then `stage`, which calls `release-packages.sh --stage`. A manual run against the tag runs `verify-public`. The workflow creates no GitHub release. Actions are referenced by commit SHA, and Dependabot updates them weekly.

## Goals / Non-Goals

**Goals:**

- One function reads every package file, for the npm package, the workspace tests and the executable.
- A missing embedded file fails the build, not a user's job.
- A reviewer can prove that the executable and the npm package carry the same Guest bundles for a version.
- A workflow installs a verified executable by naming one action commit.

**Non-Goals:**

- Changing the npm package's exports, bin, engines or published files.
- Windows, macOS x64 and Linux musl executables. See decision 4.
- macOS code signing and notarization. See decision 4.
- Package-manager distribution such as Homebrew or a container image.
- A second implementation of any command.

## Decisions for approval

### 1. One reader and one list for package files

Create `packages/health-code/src/readPackageFile.ts`. It owns the list of package files and the only function that reads them:

```ts
export const packageFiles = [
	"package.json",
	"prompts/releaseSummary.md",
	"prompts/featureMatch.md",
	"prompts/repair.md",
	"prompts/featureAdoption.md",
	"prompts/applyPatch.md",
	"prompts/verifyCredential.md",
	"prompts/investigateInspection.md",
	"dist/project.mjs",
	"dist/observe.mjs",
	"dist/agent.mjs",
	"dist/patch.mjs",
	"dist/nodeTestReporter.mjs",
] as const
export type PackageFile = (typeof packageFiles)[number]

// Resolve beside the compiled program, or one folder above this module in the package and the workspace.
const packageRoot = new URL(isStandaloneExecutable() ? "./" : "../", import.meta.url)

export function readPackageFile(path: PackageFile): Buffer {
	return readFileSync(new URL(path, packageRoot))
}
```

`index.ts`, `readPrompt.ts` and `createSandboxProvider.ts` call `readPackageFile` instead of reading relative to their own URLs. The parameter type makes every read name a listed path, so TypeScript rejects a read of an unlisted file. The executable embeds exactly the listed files at the same relative paths. One function does the reading, validation and hashing for both builds. Only the root differs, and it is chosen in one line.

Add one public export, `readPackageFileDigests()`. It reads every listed file through `readPackageFile`, validates the prompt templates through the existing `readTemplate` path and returns `{ path, sha256 }` for each file. It throws an error that names the first missing or invalid file. Decision 3 and the release use it.

A structure check in `scripts/check-structure.sh` fails when any non-test file in `packages/health-code/src` other than `readPackageFile.ts` passes `import.meta.url` to a file read. This stops a new read from bypassing the list.

Rejected:

- **Import attributes** (`with { type: "text" }` or `with { type: "file" }`). Bun inlines or embeds these files, but Node 22.18 rejects both attribute types and `tsc` keeps them, so the npm package would need a second source.
- **A generated module of file contents** committed or produced at build time. It is a second copy of every prompt and bundle that can drift from the files on disk.
- **A `--define` constant for the root.** It works only when an undeclared global is guarded with `typeof`, which is still a branch. It also hides the rule in a build flag.
- **An environment variable for the root.** Anyone who sets the job's environment could then redirect the prompts and Guest bundles.

### 2. Compile the executable

Add `apps/cli/executable/buildExecutable.ts` and a `build:executable` script. The folder sits outside `src/`, so the npm build never ships it. It runs after the library and CLI builds:

1. Call `readPackageFileDigests()` from the built `health-code` entry and copy each listed file into `apps/cli/build/executable-files/<path>`. This folder is ignored by Git.
2. Run `bun build --compile` on `apps/cli/src/cli.ts` with `--asset` set to the staged `package.json`, `prompts` and `dist`, plus `--no-compile-autoload-dotenv`, `--no-compile-autoload-bunfig`, `--no-compile-autoload-tsconfig` and `--no-compile-autoload-package-json`. The tsconfig and package.json flags restate today's defaults so that a Bun upgrade cannot change them.
3. Write `apps/cli/build/health-code-<version>-<platform>`. Platform is `linux-x64`, `linux-arm64` or `darwin-arm64`.
4. Run the new executable with `--version --json` and compare its digests with step 1. Fail the build on any missing, extra or different file. Save the output beside the executable as `<name>.files.json` for the release.

Build for the host only. The release runs this script on one native runner per platform (decision 5).

Use no `--minify`, `--bytecode` or `--sourcemap`. Minifying identifiers can rename classes and functions, which risks a difference from the npm output. It saves about 1.1 MB of 73 MB. Bytecode is not needed for a 40 ms start (decision 9). The command keeps internal errors and stack traces out of stderr, so a sourcemap would not help users.

The compile uses the Bun that `.bun-version` declares and the dependencies `bun install --frozen-lockfile` installs. The runtime inside the executable is therefore the one the unit tests use.

Rejected: cross-compiling all three targets from one Linux runner. Bun downloads each foreign runtime at build time, outside the setup action that installs and caches the declared Bun. The build machine also cannot run a foreign executable's tests.

### 3. `--version` and `--version --json`

`health-code --version` prints `health-code 0.4.0` and exits zero. `health-code --version --json` prints one JSON object:

```json
{
	"version": "0.4.0",
	"runtime": "bun 1.4.4",
	"files": { "package.json": "<sha256>", "prompts/repair.md": "<sha256>", "dist/project.mjs": "<sha256>" }
}
```

On the npm build `runtime` reads `node 24.11.0`. The `files` object lists all 13 files. Both forms call `readPackageFileDigests()` first, so a missing or invalid package file fails `--version` with its name and exit code 1. They read no settings and contact no service. The usage text adds a `health-code --version` line.

The two forms serve three checks with one code path: the build check in decision 2, the release comparison in decision 5 and a reviewer comparing an executable with the npm package.

Rejected: a hidden diagnostic subcommand. It would be undocumented surface that only tests use.

### 4. Platforms

Ship `linux-x64`, `linux-arm64` and `darwin-arm64`. The two Linux builds cover GitHub-hosted, GitLab, Buildkite and most self-hosted runners. The macOS build covers macOS CI runners and running setup on an Apple Silicon laptop.

Left out:

- **Linux musl** for Alpine containers. Bun has `bun-linux-x64-musl` and `bun-linux-arm64-musl` targets. Adding them means a native build and test job in an Alpine container for each.
- **Windows.** Signing needs an Authenticode certificate from a CA or Azure Trusted Signing, which requires identity validation and a monthly fee, plus `signtool` on a Windows runner. An unsigned binary still meets SmartScreen warnings until it builds reputation. Signing is not the only gap. Windows has no SIGTERM, so cancellation needs its own handling and test. `core.hooksPath=/dev/null` and the Runta sandbox paths would need checking under Git for Windows.
- **macOS signing and notarization.** These need an Apple Developer Program membership ($99 a year) and a Developer ID Application certificate. The binary must be signed with the hardened runtime and the JIT entitlements Bun documents (`com.apple.security.cs.allow-jit` and related keys), submitted with `xcrun notarytool` using an App Store Connect key stored as a secret, and checked online by Gatekeeper. A notarization ticket cannot be stapled to a bare executable. Without signing, a file downloaded with `curl` or `gh` has no quarantine flag and runs. A file downloaded in a browser is blocked until the user runs `xattr -d com.apple.quarantine <file>`. The guide says so.
- **macOS x64.** GitHub's default macOS runners are arm64, and an arm64 executable cannot run on an Intel Mac. Adding it means one more matrix leg on an Intel runner. npx covers it until then.

### 5. Release workflow

`release.yml` keeps its trigger and `verify` job and gets these jobs in order:

| Job | Runs on | Permissions | Does |
| --- | --- | --- | --- |
| `verify` | `ubuntu-latest` | `contents: read` | Unchanged: checks the tag against main and runs preflight. |
| `build-executable` | Matrix: `ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest` | `contents: read` | Sets up Bun from the frozen lockfile, builds the library and CLI, runs `build:executable` and the executable tests (decision 10) and uploads the executable and its `.files.json` as workflow artifacts. |
| `publish-executables` | `ubuntu-latest` | `contents: write`, `id-token: write`, `attestations: write`, `artifact-metadata: write` | Downloads the artifacts, requires the three `.files.json` files to be identical, writes `health-code-<version>.sha256`, attests the executables (decision 6) and creates or completes the GitHub release for the tag. It checks out no code and runs no repository command. |
| `stage` | `ubuntu-latest` | `contents: read`, `id-token: write` | Needs `publish-executables`. `release-packages.sh` compares the packed tarball's 13 files with the `.files.json` digests and stops before staging on any difference. Then it stages as today. |
| `verify-public` | `ubuntu-latest` | `contents: read` | Also downloads the release's Linux x64 executable, verifies it as a user would and compares its `--version --json` digests with the public npm tarball. |

A failed build in any matrix leg stops the run before any upload or staging. The `stage` job receives `NPM_TOKEN` as today. No other job sees it.

A rerun never replaces published executables. When the release already carries this version's checksum file, `publish-executables` verifies the existing files against it and their attestation, then skips the upload. The `stage` comparison uses the digests of the run's own builds of the same commit, and `verify-public` checks the published Linux x64 executable itself.

Release files for version 0.4.0:

```text
health-code-0.4.0-linux-x64
health-code-0.4.0-linux-arm64
health-code-0.4.0-darwin-arm64
health-code-0.4.0.sha256          # sha256sum format, one line per executable
health-code-0.4.0.sigstore.json   # the build provenance bundle
```

The executables ship as bare files, not archives. A user runs the bytes the checksum and provenance name, and needs no extraction step.

Recommend that the maintainer turn on immutable releases in the repository settings. GitHub then refuses to change a published release's files and tag. The workflow creates the release as a draft, uploads the files and then publishes it, which immutable releases require.

Rejected:

- **Building the executables after npm staging.** A failed build would leave an npm version with no executable.
- **One job that builds and uploads.** That job would hold `contents: write` while running repository code.

### 6. Provenance and how to verify it

The `publish-executables` job runs `actions/attest` once with `subject-checksums` set to the checksum file. Since version 4, `actions/attest-build-provenance` only wraps `actions/attest`, and new workflows use `actions/attest` directly. That attests all three executables in one SLSA v1 provenance statement. Sigstore signs it with the workflow's OIDC identity, and GitHub stores it in the repository's attestations. The job also uploads the Sigstore bundle as `health-code-<version>.sigstore.json` for verifiers that do not use GitHub's API.

A user verifies with:

```sh
sha256sum --check --ignore-missing health-code-0.4.0.sha256
gh attestation verify health-code-0.4.0-linux-x64 \
  --repo doubleoevan/health-code \
  --signer-workflow doubleoevan/health-code/.github/workflows/release.yml \
  --source-ref refs/tags/v0.4.0 \
  --deny-self-hosted-runners
```

On macOS the first command is `shasum -a 256 --check --ignore-missing health-code-0.4.0.sha256`. Without GitHub's API, `cosign verify-blob-attestation` checks the same file against the Sigstore bundle with the release workflow's certificate identity and GitHub's OIDC issuer.

The checksum proves the download is the published file. The attestation proves this repository's release workflow built it from that tag on a GitHub-hosted runner. npm provenance for the package is unchanged.

Rejected:

- **A detached GPG or minisign signature.** It needs a long-lived private key in CI secrets and its own key distribution.
- **Checksums alone.** They come from the same release as the file, so they cannot detect a replaced release.

### 7. The GitHub Action

Ship a composite action at the repository root, `action.yml`, with its script in `action/install-executable.sh` and an `action/AGENTS.md`. A workflow uses it like this:

```yaml
- uses: doubleoevan/health-code@<commit SHA of v0.4.0> # v0.4.0
- run: health-code check https://github.com/${{ github.repository }} --pull-request
  env:
    RUNTA_TOKEN: ${{ secrets.RUNTA_TOKEN }}
```

Inputs:

- `version`. Defaults to the version in `packages/health-code/package.json` at the action's own commit, read from `github.action_path`. The action's commit therefore decides the executable's version.
- `token`. Defaults to `github.token`. It is used only to download release files and read attestations.

The script maps `runner.os` and `runner.arch` to a platform. It fails with the supported platforms and the npx command on any other runner. Then it downloads the executable and the checksum file with `gh release download`, checks the checksum and runs the `gh attestation verify` command from decision 6, adding `--source-digest` with the action's commit when a workflow references the action by commit and sets no version. Then it runs the downloaded file's `--version` to confirm the version. Last, it moves the file to `$RUNNER_TEMP/health-code/bin` and adds that folder to `GITHUB_PATH`. A failed step leaves nothing on `PATH`.

The action holds no checksum of its own. The release workflow builds the executables after the tag exists, so the tagged commit cannot contain their checksums. The attestation binds a file to the workflow and tag instead, and that binding never goes stale. Dependabot's `github-actions` updates already cover a root action used by commit SHA with a version comment.

Rejected:

- **A checksum file committed after each release.** The workflow would have to push to main, and users would have to wait for that later commit.
- **A JavaScript action.** It needs a `node_modules` folder or a bundled build in the repository. A shell script with `gh` and `sha256sum` needs neither, and GitHub-hosted runners provide both.
- **A subfolder action** such as `doubleoevan/health-code/install@…`. It works the same but makes every `uses:` line longer. GitHub Marketplace requires a root `action.yml` and a repository without workflows, so Marketplace listing stays out of scope either way.

### 8. Runtime parity on Bun

The unit tests already run on Bun, so the executable runs the library on the runtime that is tested most. The risks sit where the tests use fakes. Each gets a check:

| Behavior | Risk on Bun | Check |
| --- | --- | --- |
| SIGTERM and SIGINT delete sandboxes | Signal delivery to `process.once` in a compiled program | Live: send each signal to the executable after the log shows the sandbox, then assert exit code 1 and that Runta lists no sandbox with the Inspection's name prefix. |
| `--pull-request` drives `git` and `gh` with hooks off | `execFile` time limits and environment in a compiled program | Offline: the existing `checkRepository` pull request tests already run on Bun. Live: run `--pull-request` against a local bare remote with a `gh` stub on `PATH` and a hook that writes a marker. Assert the branch was pushed, the stub received the pull request call and the marker is absent. |
| Sandbox command stream | Bun's built-in `ws` replaces the package: headers, close and error events | Live: the fixture inspection streams every sandbox command through the executable. |
| Model requests | `fetch` streaming, abort and redirect handling | Live: the fixture inspection makes summary, matching and repair requests. |
| Exit codes and output | `process.exitCode` and stdout flushing at exit | Offline: compare the executable's and the npm CLI's stdout, stderr and exit codes for usage, `--version`, missing settings and bad arguments. |
| Repository configuration | Autoloaded `.env` and `bunfig.toml` | Offline: run the executable in a folder whose `bunfig.toml` preloads a script that writes a marker and whose `.env` sets `HEALTH_CODE_MODEL`. Assert no marker and that the missing-settings error still names `HEALTH_CODE_MODEL`. |

The live parity check runs the fixture Repository and its commit from `test/providerContract.ts` with a named upgrade that passes its checks and `--upgrade-only`. The Verdict then depends on the checks and not on a model's wording. The check runs the npm CLI and the executable in turn and compares the reports' Verdicts and check statuses.

### 9. Size and start time

Measured on macOS arm64 with Bun 1.4.3:

| Measure | Value |
| --- | --- |
| Bun runtime | 70.5 MB |
| Compiled CLI without the embedded files | 73.2 MB |
| Guest bundles to embed | 3.3 MB |
| Prompt templates | under 32 KB |
| Expected executable | about 76.5 MB |
| Start to usage text, Bun bundle | 40 to 50 ms |
| Start to usage text, npm CLI on Node 26 | 180 to 190 ms |

Linux sizes are measured in the first release build and recorded in this section. Start time is under a quarter of the npm CLI's, so the build gets no start-time limit. CI timing is too noisy for a useful gate.

The build gets one size limit. It fails when the executable exceeds the Bun runtime binary's size by more than 15 MB. The embedded code and files are about 6 MB today. Twice that plus headroom catches an accidental embed, such as `node_modules` or the whole `dist/` folder, without tracking Bun's own growth.

### 10. Docs and tests

**Docs.** `apps/cli/README.md` leads with the executable for pipelines. The order is the action, then a manual download for other CI systems (`curl` the executable and the checksum file for one exact version, check the checksum, verify the attestation, `chmod +x`), then npx with Node 22.18 or later. The weekly workflow example uses the action and drops `actions/setup-node`. The guide states that the executable needs nothing else on the machine, except `git` and `gh` for `--pull-request`. It also covers the macOS quarantine note from decision 4. The root README's CI quick start and the package README follow. The library README keeps npx for library users. The prose avoids the word "pin", per the project's naming rule.

**Offline tests**, in `apps/cli/executable/executable.test.ts`. They run when `apps/cli/build/` holds an executable for the host and skip otherwise. The release build job and `bun run test:executable` always build one first:

- Prints `--version` and the usage text identical to the npm CLI.
- Fails with the same messages and exit codes as the npm CLI for missing settings and bad arguments.
- `--version --json` lists all 13 files, and each digest equals the workspace file's.
- Ignores `.env` and `bunfig.toml` in its working directory.

The build check in decision 2 fails the build when a listed file is not embedded. The structure check in decision 1 fails preflight when a read bypasses the list.

**Live test**, in `apps/cli/executable/executable.live.ts`, run by a new `bun run test:executable:live`. It skips unless `RUNTA_TOKEN` and the model settings are set, and covers the live rows of decision 8.

Preflight does not build the executable. It still runs the unit tests, and the structure check covers the list.

## Risks / Trade-offs

- [Guest bundles built on different runners differ, for example through an absolute path in a bundle comment] → The three `.files.json` files and the npm tarball are compared before any upload or staging, so a difference stops the release instead of shipping.
- [A Bun upgrade changes compile defaults or `$bunfs` layout] → The build check runs the fresh executable, and the configuration test runs on every release build. Bun updates go through Dependabot and `.bun-version` like any other dependency.
- [The executable is about 76 MB per download] → GitHub release downloads on hosted runners take a few seconds. The action could cache by version later if needed.
- [`BUN_OPTIONS` and `BUN_BE_BUN` in the job environment change how the executable starts] → Only the job's own configuration sets these, and a repository checkout cannot. The guide says so. `--trim` would remove `BUN_BE_BUN`, but it is experimental.
- [The action needs `gh`] → GitHub-hosted runners have it. On a self-hosted runner without it, the action fails and names the manual commands.
- [An action commit on main after the version bump and before the release] → The action fails with "release v<version> not found". Dependabot proposes only tagged releases.
- [An unsigned macOS executable] → It covers CI and `curl` downloads. Browser downloads need one documented command.

## Migration Plan

1. Land decisions 1 and 3 first. The npm package changes only in how it locates the same files, and preflight plus `check:package` confirm the published shape.
2. Land the build script, tests, action and docs.
3. Release the next minor version. Check that the release includes the five files, then run the verification commands and the action on a scratch workflow before switching CarlNotes' CI to the executable.

To roll back, point CI back to `npx health-code`, or reference the action at an earlier release's commit. Immutable releases keep the published files, so a rollback never edits a release. npx keeps working because the npm package is unchanged.

## Verify during implementation

- Found on 2026-11-26: `actions/attest` v4.2.2 (`1e69f48acb82d1966a394da916b4c1698aa569d6`) accepts `subject-checksums`, outputs `bundle-path` and writes SLSA build provenance when no predicate is given. It needs `id-token: write`, `attestations: write` and `artifact-metadata: write`. `actions/upload-artifact` is v7.0.2 (`cf430e030ddbb5b0abf93d22962f4752f3646cd9`) and `actions/download-artifact` is v8.0.2 (`9000827ccba6bdab643e8b6fd33ac0654aef8333`). The runner images list `ubuntu-24.04-arm` as arm64 and `macos-latest` as macOS 26 arm64.
- Found on 2026-11-26 with Bun 1.4.3: a build without the autoload flags ran a checkout's `bunfig.toml` preload script and read its `.env`. The flags stop both, and `executable.test.ts` checks it.
- The first build measured 73.0 MiB on macOS arm64, with all 13 package files embedded. `--version` starts in 50 to 60 ms, including the digest of every file.
- The release workflow is checked only by YAML parsing and `scripts/releaseWorkflow.test.ts` until a tag runs it. `actionlint` was not available.
- Found on 2026-11-26: `gh` 2.103.1 accepts `--signer-workflow`, `--source-ref` and `--deny-self-hosted-runners` on `gh attestation verify`. Still to confirm: the `gh` version on GitHub-hosted runners and the exact `cosign verify-blob-attestation` flags for a bundle.
- That Bun 1.4.4 behaves as the 1.4.3 probe found for `--asset`, `import.meta.url` and `Bun.isStandaloneExecutable`.
- That a file from `gh release download` or `curl` carries no `com.apple.quarantine` flag on macOS.
- Found on 2026-11-26 in the first live run: the executable created a Runta sandbox, streamed every sandbox command, started the Model Request Sandbox, summarized release notes through it and deleted both sandboxes. Bun's `ws` replacement therefore sends the `Authorization` header and delivers `message`, `error` and `close` as the Runta SDK expects. SIGTERM deleted the sandbox before exit. After SIGINT, Runta still listed the deleted sandbox for a few seconds, so the live test waits up to a minute for the listing to clear and also requires the command's own deletion log line.
- Found on 2026-11-26: Nano ID at the fixture commit cannot produce a patch. Its test runner prints no test cases the inspector can count, so every upgrade there ends Untested with "Baseline has no comparable passing test cases". The executable and the npm command agreed on that Verdict and those check statuses: vite 8.4.0 is Untested, with install passed, typecheck untested for no `tsconfig` and tests passed. The pull request case therefore runs runta-dev/jot at `55c3082` with `@types/node` 24.13.5 to 24.19.4, which ends Passes as is with all three checks passed. A first try with errand's `typescript-eslint` bump ended Can't fix on an unrelated UI test after 21 minutes.
- Found on 2026-11-26: the full live suite passed. The Verdict and signal cases took about 12 minutes, and the jot pull request case 12 more. `--pull-request` needs the commit's history: a depth-1 fetch made the push to the bare remote fail, as the guide's full checkout rule predicts.
- That immutable releases allow the draft, upload and publish sequence from a workflow.
- The Linux executable sizes, recorded in decision 9.
