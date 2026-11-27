# Development

Use the Bun version in `.bun-version`. From the repository root, run `bun install --frozen-lockfile`, then `bash scripts/preflight.sh`. The test suite covers repository checks and the inspection engine using recorded fixtures. Claude Code runs the same comment check after file edits and writes. Hook mode uses `jq` to read the edited path. For `.tsx`, follow the JSX section-comment rules and review them during `/ship`.

| Command | What it checks |
| --- | --- |
| `bun run check` | Runs preflight, the same command used by CI and /ship. Stops at the first failure. |
| `bash scripts/check-comment-groups.sh --tracked` | Flags runs over eight uncommented statement lines in tracked `.ts`, `.mts`, `.js`, `.mjs` and `.sh` files. |
| `bun run check:style` | Checks formatting, lint rules and import order with Biome. |
| `bun run check:structure` | Checks the placement of package manifests. |
| `bun run check:boundaries` | Checks imports, dependency declarations and TypeScript references across the workspaces. |
| `bun run check:declared-versions` | Compares the declared Bun versions and verifies patched dependency versions against the lockfile. |
| `bun run check:unused` | Finds unused files, exports, types and dependencies with Knip. |
| `bun run typecheck` | Typechecks the scripts and every product workspace. |
| `bun run test` | Runs the tooling and workspace test suites with Bun. |
| `bun run --cwd packages/health-code build` | Builds the ESM library, declarations and the sandbox guest tools. |
| `bun run inspect <repo-url> [--fake]` | Prints the live inspection log and saves the versioned Inspection Report to `logs/`. Use `--fake` for a credential-free fixture replay. For a live inspection, use `doppler run -- bun run inspect <repo-url>`. |
| `bun run --cwd apps/cli build` | Compiles the Node CLI from `apps/cli` into `packages/health-code/dist/cli/`. |
| `bun test ./apps/cli` | Exercises the CI command, account setup and sandbox recovery offline. |
| `bun run --cwd apps/web build` | Builds the Vite browser entry for the Hono server. |
| `bun run --cwd apps/web start` | Serves the built page, Inspection API and event stream. |
| `bun run --cwd apps/web dev` or `replay` | Serves live local inspections (`dev`) or a recorded example (`replay`) with hot reload. |
| `bun run check:package` | Packs the library and verifies its public entry in fresh Node and Bun consumers with frozen workspace dependencies. |
| `bun run test:provider` | Runs the shared production contract and two public fixtures at fixed commits when the test harness has `RUNTA_TOKEN`. |
| `doppler run -- bun run eval --case removed-apis` | Scores the historical repair under the default limits. `linked-dependencies` scores a repair that upgrades linked dependencies. `matching-versions` scores one that upgrades two packages to the same version. `mocked-import-path` scores one that changes a mocked path. `--all` scores every case. |
| `doppler run --only-secrets RUNTA_TOKEN -- bun run eval --case baseline-test-counts --record` | Measures test counts and test file errors at the case's commit and writes the case file for review. |
| `bun run check:advisories` | Queries the registry and fails on unreviewed high or critical advisories or stale exceptions. CI runs it separately. |

Every module keeps its own AGENTS.md current with the README. For an approved change, implement it, run `/ship`, archive with OpenSpec, commit the implementation and archive together, then push to main.

Preflight needs no credentials. Doppler project `health-code`, config `dev`, holds application secrets. See [AGENTS.md](AGENTS.md) for module ownership, test rules, and the shipping workflow.

## Run the site locally

Build the library and serve live local inspections with hot reload:

```sh
bun run --cwd packages/health-code build
doppler run --project health-code --config dev -- bun run --cwd apps/web dev
```

Open `http://localhost:3000` and inspect any public repository. The site uses the required settings from the CI guide. Run setup once so Runta holds your key and leave `MODEL_API_KEY` set for the site. Live inspections spend your own Runta and model credits.

Without credentials, `bun run --cwd apps/web replay` plays one recorded inspection for interface work. The [hosting guide](apps/web/HOSTING.md) covers deployment.

## Model inspections

Run `bun run test:credential` with the sandbox token and the model settings from the [CI guide](apps/cli/README.md#setup) to verify the live gateway. Run `bun run eval --case removed-apis` to score a repair case against the default budgets. The `baseline-test-counts` case supports `--record` for a new measurement. Scoring requires reviewed counts and test file errors.

## Standalone executable

Run `bun run test:executable` to build the library, the npm CLI and the standalone executable for this machine, then compare the executable with the npm CLI on Node. The executable lands in `apps/cli/build/health-code-<version>-<platform>` beside its `.files.json` digests. `bun run --cwd apps/cli build:executable` builds it alone after the library and CLI builds. The build fails when the executable is missing a package file, reads one with different bytes or adds more than 15 MB to the Bun runtime. It builds for Linux x64, Linux arm64 and macOS arm64 only.

Run `doppler run --project health-code --config dev -- env -u MODEL_API_KEY bun run test:executable:live` before a release that changes the command or the runtime. It runs real inspections through the executable: the Verdict against the npm CLI, a pull request with hooks off, and sandbox deletion after SIGTERM and SIGINT. It needs `RUNTA_TOKEN`, `HEALTH_CODE_MODEL_HOST` and `HEALTH_CODE_MODEL`, skips without them, and takes about 25 minutes. Run it while no other inspection uses the Runta account, because the signal checks count every sandbox created during the run.

## Release and hosted verification

Run `bash scripts/release-packages.sh --dry-run` to build and inspect the npm tarball locally. The package trusts `doubleoevan/health-code` and `release.yml` with staged publishing permission and no GitHub environment. While npm rejects the repository’s immutable sign-in subject ([npm/cli#9969](https://github.com/npm/cli/issues/9969)), keep the `NPM_TOKEN` repository secret in place to stage each release. A matching tag builds and tests the standalone executable on each platform, publishes the executables with a checksum file and build provenance on the GitHub release, then stages the tarball with provenance. The tarball stages only after every executable reports the same package files it includes. Approve the version on npmjs.com. Run the release workflow manually against the same tag to verify the public digests and signed provenance, and the published Linux x64 executable. Keep immutable releases turned on in the repository settings. `.github/AGENTS.md` lists each release job and its permissions. If a stage is already pending, review it on npmjs.com before retrying the workflow.

Run `bun x playwright install chromium` once for browser acceptance. Use `bun run test:hosted` with the deployment origin, its Runta namespace and its inventory credentials supplied through Doppler. The browser uses the public submission form, including Turnstile. Each completed case writes its report URL, revision, prompt versions and observed verdicts under `logs/hosted/`. A new hosted deployment commit starts a fresh inspection cache. Existing report links keep working. Retrying a partial inspection checks the baseline again, reuses completed upgrades at the same commit and release, and runs the remaining upgrades under the usual limits. Each reused upgrade links to the inspection that tested it. The script reopens the first repository through the cache and checks provider inventory for leftover runtimes. A daily cap can require continuing the suite after midnight UTC.
