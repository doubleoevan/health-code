# Tasks

## 1. GitHub confirmations on this repository

- [x] 1.1 Confirm with a workflow started by hand from a branch that the workflow token creates, fast-forwards and reads a reference under `refs/health-code/`, and that a second create of the same reference fails. Delete the reference after. Record the result under design decision 4, and switch to the tag fallback there if it fails.
- [ ] 1.2 Confirm on this repository's own Dependabot pull requests which token and which secrets the `pull_request_target` and `workflow_run` runs get. Record the observed table under design decision 2.
- [ ] 1.3 Confirm on the first Health Code pull request here what its CI does: approval-required runs or no runs. Record it under design decision 6.
- [ ] 1.4 Confirm what Dependabot does with its open pull request after Health Code's merges. Record it under design decision 7 and in the CI guide.

## 2. Pull request target in the library

- [x] 2.1 Add recorded GitHub fixtures for the fake GitHub in `packages/health-code/test/fixtures/`: npm, pnpm, Yarn and Bun single upgrades, one package in several workspaces, a family, a major, a 0.x minor, a 0.x patch, a grouped pull request, a lockfile-only change, a transitive-only change, an action bump, a fork's branch named like a bot's, a pull request that also changes other files and Renovate's, Dependabot's and a person's author and branch shapes. Verify each fixture loads through `createFakeGithub`.
- [x] 2.2 Implement `readPullRequestTarget` in `packages/health-code/src/upgrades/` per design decision 3, reusing `readRepositoryFiles`, `readLockedDependencies`, `toUpgradeKind` and `isPackageName`, and export it with its result type from the public entry. Verify `bun test ./packages/health-code` passes a test per fixture and per reason in the `ci-inspections` delta.
- [x] 2.3 Add tests that a name failing npm's grammar never appears in a result, that an unreadable repository returns `unreadable` and that every request goes to GitHub's API origin. Verify they fail when the grammar check is removed.
- [x] 2.4 Add Dependency pull request, Package family, Inspection mark and Start path to `.agents/skills/domain-model/SKILL.md`, and document the function in `packages/health-code/GUIDE.md` and `AGENTS.md`. Verify the guide's example runs against the fake GitHub in a test.

## 3. The target command

- [x] 3.1 Add `health-code target <pull-request-url>` in `apps/cli/src/` and dispatch it from `cli.ts`, with the usage line and failure messages through `toFailureMessage`. Verify `bun test ./apps/cli` covers a target, a reason, an invalid URL and a GitHub rate limit, with the exit code of each.
- [x] 3.2 Add the new commands' usage errors to the parity cases in `apps/cli/executable/executable.test.ts`, so the standalone executable and the npm CLI print the same output and exit code for each without a network. Verify `bun run test:executable` passes.
- [x] 3.3 Document the command, its output and its reasons in `apps/cli/README.md` and `apps/cli/AGENTS.md`. Verify the documented example output matches a test snapshot.

## 4. The start decision

- [x] 4.1 Implement the `select` step in `apps/cli/src/`: read the event file, apply the settings from the environment and decide `inspect`, `report` or `none` with the path and a fixed reason, per the `dependency-pull-requests` spec. Verify unit tests cover each scenario of the Major, Red, Asked and leave-alone requirements from recorded event files.
- [x] 4.2 Implement the Red rule: the failed checks on the head, the same names on the base commit and the `red-checks` filter. Verify tests cover a failure the base commit shares, a check with no result on the base commit, a check outside the list and a green run.
- [x] 4.3 Implement the Asked rule: the label name and the sender's permission through GitHub's API. Verify tests cover write, triage and read permission and another label.
- [x] 4.4 Write the decision to the job outputs and the reason to the run summary without any pull request text beyond checked names and versions. Verify a test with a crafted branch name, title and package name finds none of them in either file.

## 5. Marks and weekly spend

- [x] 5.1 Implement the Inspection mark on the reference design decision 4 settles: claim, finish, read and replace. Extend the fake GitHub with references and commits. Verify tests cover a first claim, a lost claim, a finished record and a replace on the Asked path.
- [x] 5.2 Implement the weekly spend record: one reference per inspection under its ISO week, and the week's total as their sum. Verify tests cover a new week, costs that several runs record at once and an inspection with no measured cost counted at its cost limit.
- [x] 5.3 Apply the mark and the cap in `select` and again at the claim. Verify tests cover a second red CI, a rebase, two events at once and each `at-cap` value.

## 6. Inspect and report

- [x] 6.1 Implement the `inspect` step: check the outputs it received, stop with the Dependabot secret message when `RUNTA_TOKEN` is empty, claim the mark, set the `pending` status and run the check at the base commit with `--pull-request`, and with `--upgrade-only` unless the path is Asked or `feature-patches` is on. Verify tests with the fake Sandbox Provider and a stub `gh` cover each path's flags and a rejected version.
- [x] 6.2 Implement the comment as fixed copy plus the fields in the design's comment section, found again by its marker and replaced. Verify tests cover a tested Patch, each no-Patch sentence, both moved-package differences, a not-inspected comment and a second inspection that leaves one comment, and that no report free text reaches the comment.
- [x] 6.3 Implement the `report` step: the final status from the Verdict, `error` when no report exists, the spend record, the mark's record and the label removal. Verify tests cover each Verdict, a missing report and the status copy to a new head.
- [x] 6.4 Bound the inspection ten minutes inside the job's time limit and delete the sandboxes when it is reached. Verify a test with a short limit ends with the `error` status and the did-not-finish comment.

## 7. The wait step

- [x] 7.1 Add a source path setting to `action/install-executable.sh` so a caller other than the root action can name the checkout and the commit to require. Verify `scripts/installExecutable.test.ts` covers the new setting and the existing cases still pass.
- [x] 7.2 Implement `health-code wait` in `apps/cli/src/`: return at once for an event that is not a dependency pull request with one major upgrade, otherwise poll the `health-code` status until it leaves `pending` or the time limit passes. Verify tests cover each scenario of the wait requirement, with and without `require-inspection`.
- [x] 7.3 Add `action/wait/action.yml` with the inputs from design decision 5. Verify a test parses it and finds no expression in a run step and no action referenced by anything but a commit SHA.
- [x] 7.4 Document the wait step, its inputs and its permissions in `apps/cli/README.md` and `action/AGENTS.md`. Verify the documented snippet parses as YAML in a test.

## 8. The reusable workflow

- [x] 8.1 Write `.github/workflows/dependency-pull-requests.yml` per design decision 1: the inputs, the `select` and `inspect` jobs, the two checkouts, the install from `job.workflow_sha`, the concurrency group with `queue: max`, the artifact upload and the report step on every outcome. Verify `actionlint` or GitHub's workflow validation accepts the file.
- [x] 8.2 Add `scripts/dependencyPullRequestsWorkflow.test.ts` beside `releaseWorkflow.test.ts`. It fails when a checkout step names a pull request ref, when a run step contains a workflow expression, when a job other than `inspect` references a secret or holds a write permission, or when an action is not referenced by a 40-character commit SHA. Verify each rule with a broken copy of the file.
- [x] 8.3 Rewrite the CI section of `apps/cli/README.md`: dependency pull requests first with the whole caller, the settings table, the permissions, the Dependabot secret and the approval of CI on Health Code's pull request, then the weekly schedule, then the form. Point the root README's CI section to it. Verify a test finds the caller's permissions equal to the `inspect` job's.
- [x] 8.4 Update the root `AGENTS.md` module map and routing table, `.github/AGENTS.md`, `scripts/AGENTS.md` and `apps/cli/AGENTS.md` for the workflow, its test and the new commands. Verify every path they name exists.

## 9. This repository's caller

- [x] 9.1 Add `.github/workflows/health-code.yml`: the guide's caller with `workflows: [CI]`, the local `uses`, the model host and model from `evaluations.yml` and `RUNTA_TOKEN`. Leave `.github/dependabot.yml` unchanged. Verify the caller's triggers, permissions and `if` line equal the guide's in a test.
- [x] 9.2 Make the install take the release the package version names when the workflow is called from its own repository, per design decision 1. Verify `scripts/installExecutable.test.ts` covers a local-path call at a commit that is not the release's.
- [x] 9.3 Extend `scripts/dependencyPullRequestsWorkflow.test.ts` to this caller: every action referenced by commit SHA or local path, `RUNTA_TOKEN` as its only secret and no checkout of a pull request ref. Verify each rule with a broken copy.
- [x] 9.4 Say in the root README that Health Code runs on its own Dependabot pull requests, and list the caller in `.github/AGENTS.md` with the manual steps from design decision 2. Verify the README sentence names the workflow file that exists.

## 10. The live check

- [x] 10.1 Add the hand check of the first Dependabot major after a release to `DEVELOPMENT.md`: one status, one comment, one Health Code pull request, one mark and nothing new after a CI re-run. Verify the documented command lists the references under `refs/health-code/`.

## 11. Integration

- [x] 11.1 Run `bash scripts/preflight.sh` from the repository root and verify it passes.
- [x] 11.2 Run `bun run test:executable` and verify the executable carries the `target`, `wait` and `dependency-pull-request` commands with the package file digests unchanged in shape.
- [x] 11.3 Run `openspec validate add-dependency-pull-requests --strict` and verify it passes.

## Workflow follow-up

- Run `/ship`, archive the change with the OpenSpec CLI and commit the implementation and the archive together on `main`, each with the maintainer's approval.
- After the next release's executables publish, run the hand check in `DEVELOPMENT.md` on this repository's first Dependabot major.
- The maintainer completes the manual steps of design decision 2 for this repository: the variable before the push, then the Dependabot secret, the setting and the label, then deleting the variable after the release.
- Put the link to this repository's first inspected Dependabot pull request in the README.
- Add the release's commit to the CI guide's table and replace each **To confirm** note in the guide with the observed behavior.
