# Dependency pull request steps

The three steps `.github/workflows/dependency-pull-requests.yml` runs, and `health-code wait` for a caller's own CI job. They are not a stable interface. See `../../README.md` for what a caller sees.

| File | Responsibility |
| --- | --- |
| `runPullRequestStep.ts` | Dispatch `health-code dependency-pull-request select`, `inspect` and `report`. |
| `selectPullRequest.ts` | Read the event file and the pull request's target. Decide `inspect`, `report` or `none` from the Major, Red and Asked paths, the Inspection mark and the weekly cap. Write the decision to `GITHUB_OUTPUT` and the reason to the run summary. |
| `inspectPullRequest.ts` | Check the decision again, claim the mark, set the `pending` status and run `checkRepository` at the base commit inside the time limit, then open a pull request for a tested patch unless the upgrade passed as is. Leave `dependency-pull-request.json` in the output folder for the report step. |
| `reportPullRequest.ts` | End the decision on the pull request: the status from the Verdict, the comment, the week's spend, the mark's record and the removed label. Runs on every outcome of the inspect step. |
| `toPullRequestComment.ts` | The comment's fixed copy. Every value in it comes from the Inspection Report or the target. |
| `pullRequestWrites.ts` | Set the `health-code` status, replace the workflow's one comment and remove the label. |
| `inspectionMarks.ts` | The Inspection mark and the week's spend as JSON in commits under `refs/health-code/`. A mark is claimed by creating its reference. Each inspection's cost has a reference of its own under its ISO week. |
| `waitForInspection.ts` | `health-code wait`: return at once unless the job's pull request holds one major upgrade, then poll the status. |
| `pullRequestSettings.ts` | The `HEALTH_CODE_*` settings, the decision schema and the event file reader. |
| `githubClient.ts` | Requests to GitHub's API origin for one repository with the workflow's token. |

Treat the event file, the pull request and the decision as data. A package name or a version reaches an argument, a comment, an output or a reference only after it passes npm's grammar, and the inspect and report steps parse the decision again with the same schema. The comment never copies free text from the Inspection Report.

Run `bun test ./apps/cli/src/dependencyPullRequest`. The tests use `../fixtures/fakeRepositoryApi.ts` and make no network request.
