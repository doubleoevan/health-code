# CI command

This workspace owns the `health-code check`, `target`, `wait` and `setup` commands and the `dependency-pull-request` steps the reusable workflow runs. Its build ships inside the `health-code` package. Import inspection behavior from the public `health-code` entry.

Sources, their tests and `src/fixtures/` sit in `src/`.

| Entry | Responsibility |
| --- | --- |
| `cli.ts` | Dispatch `check`, `setup` or `--version` and print the usage for anything else. |
| `describeVersion.ts` | Print the release for `--version`. With `--json`, add the runtime and the digest of every package file the library reads. |
| `checkRepository.ts` | Run `health-code check` for CI and write the report and patches. |
| `describeTarget.ts` | Run `health-code target`: parse a pull request's address, read its upgrade through the library and print the JSON. |
| `selectCheckTarget.ts` | Decide what a check tests before any sandbox exists. Resolve a named version through the library, or build the upgrade menu, save it as `upgrade-menu.json` and take its first target. Fall back to the sandbox for a project GitHub cannot serve. |
| `dependencyPullRequest/selectPullRequest.ts` | Decide from the event file whether a dependency pull request starts an inspection, gets a report without one or starts nothing: the Major, Red and Asked paths, the Inspection mark and the weekly cap. Write the decision to the job's outputs and the reason to the run summary. |
| `dependencyPullRequest/inspectPullRequest.ts` | Check the decision again, claim the mark, set the pending status and run the check at the base commit inside the time limit. Leave a state file for the report step. |
| `dependencyPullRequest/reportPullRequest.ts`, `toPullRequestComment.ts`, `pullRequestWrites.ts` | End the decision on the pull request: the status from the Verdict, one comment of fixed copy and report fields, the week's spend, the mark's record and the removed label. |
| `dependencyPullRequest/inspectionMarks.ts` | Keep the Inspection mark and the week's spend as JSON in commits under `refs/health-code/`. Creating a reference claims a version once. Each inspection's cost has a reference of its own under its ISO week, and the week's total is their sum. |
| `dependencyPullRequest/waitForInspection.ts` | Run `health-code wait` for a caller's CI job: return at once unless the pull request holds one major upgrade, then poll the `health-code` status. |
| `dependencyPullRequest/pullRequestSettings.ts`, `githubClient.ts`, `runPullRequestStep.ts` | Read the workflow's settings and the decision schema, send the workflow's token to GitHub's API origin only and dispatch the three steps. |
| `openPullRequest.ts` | Apply an upgrade’s tested patches on a branch of the current checkout and open or update its pull request through `git` and `gh`. Keep the checkout’s hooks off and return it to its starting commit. |
| `readEnvironmentSettings.ts`, `userError.ts`, `configureModels.ts`, `inspectWithAccount.ts` | Read the required model settings through the library, name every missing one and run inspections with the account’s origin-bound credential. No model is chosen by default. |
| `setupAccount.ts`, `probeModelRequestSandbox.ts` | Register or reuse the model key. Verify it with a request limited to one output token and confirm model request sandbox deletion before naming the CI settings. |
| `personalModelRequestSandboxes.ts` | Record each intended model request sandbox allocation by account and host. Use the verified organization ID across token rotations. Recover allocations whose local owner process has exited. |
| `toFailureMessage.ts` | Give each failure its cause and next step. |
| `toEventLine.ts` | Describe one inspection event for the CI log. |
| `src/fixtures/` | Share recorded Inspection inputs, model replies and the check runner between the unit tests. |

`executable/` builds and tests the standalone executable. `buildExecutable.ts` stages the files `readPackageFileDigests` lists, compiles `src/cli.ts` with Bun with `.env`, `bunfig.toml`, `tsconfig.json` and `package.json` autoloading off, and fails when the executable's package file digests or size are wrong. `checkExecutable.ts` holds those checks and the platform names. `executable.test.ts` compares the built executable with the npm CLI on Node. Run `bun run test:executable` from the root for all of it. `executable.live.ts` runs against Runta and a model through `bun run test:executable:live`, which skips without `RUNTA_TOKEN`, `HEALTH_CODE_MODEL_HOST` and `HEALTH_CODE_MODEL`. It compares both builds' Verdict on Nano ID, opens a pull request from a jot checkout through a stub `gh` and a local remote with hooks that must not run, and stops the executable with SIGTERM and SIGINT to check that its sandboxes are deleted. It takes about 25 minutes. The output in `build/` is ignored by Git.

Run `bun run --cwd apps/cli build` after building the library. Run `bun test ./apps/cli` for setup and command behavior. The tests use temporary homes, a fake Sandbox Provider and recorded evidence. The build emits JavaScript into `../../packages/health-code/dist/cli/` for the shared release. See `README.md` for the CI settings.

The command sets `callerModelExecution` to `"modelRequestSandbox"`. After setup a job needs `RUNTA_TOKEN` and the model settings. The command chooses no default model. It reads the GitHub token from `GITHUB_TOKEN` and otherwise `GH_TOKEN`. `--upgrade-only` passes `limits.maxFeatureMatches: 0`, which skips Code Feature Matches and Feature adoption.

The `dependency-pull-request` steps are for `.github/workflows/dependency-pull-requests.yml` and are not a stable interface. They read the event from `GITHUB_EVENT_PATH`, settings from `HEALTH_CODE_*` variables and the select step's decision from `HEALTH_CODE_DECISION`, and check every value in the decision again before use. Nothing from a pull request reaches a comment, an output or a reference except a package name and a version that pass npm's grammar.
