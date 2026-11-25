# CI command

This workspace owns the `health-code check` and `health-code setup` commands. Its build ships inside the `health-code` package. Import inspection behavior from the public `health-code` entry.

Sources, their tests and `src/fixtures/` sit in `src/`.

| Entry | Responsibility |
| --- | --- |
| `cli.ts` | Dispatch `check` or `setup` and print the usage for anything else. |
| `checkRepository.ts` | Run `health-code check` for CI and write the report and patches. |
| `openPullRequest.ts` | Apply an upgrade’s tested patches on a branch of the current checkout and open a pull request through `git` and `gh`. |
| `readEnvironmentSettings.ts`, `userError.ts`, `configureModels.ts`, `inspectWithAccount.ts` | Read the required model settings through the library, name every missing one and run inspections with the account’s origin-bound credential. No model is chosen by default. |
| `setupAccount.ts`, `probeModelRequestSandbox.ts` | Register or reuse the model key. Verify it with a request limited to one output token and confirm model request sandbox deletion before naming the CI settings. |
| `personalModelRequestSandboxes.ts` | Record each intended model request sandbox allocation by account and host. Use the verified organization ID across token rotations. Recover allocations whose local owner process has exited. |
| `toFailureMessage.ts` | Give each failure its cause and next step. |
| `toEventLine.ts` | Describe one inspection event for the CI log. |
| `src/fixtures/` | Share recorded Inspection inputs and model replies between the unit tests. |

Run `bun run --cwd apps/cli build` after building the library. Run `bun test ./apps/cli` for setup and command behavior. The tests use temporary homes, a fake Sandbox Provider and recorded evidence. The build emits JavaScript into `../../packages/health-code/dist/cli/` for the shared release. See `README.md` for the CI settings.

The command sets `callerModelExecution` to `"modelRequestSandbox"`. After setup a job needs `RUNTA_TOKEN` and the model settings. The command chooses no default model.
