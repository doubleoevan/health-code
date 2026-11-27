# Design

Eight decisions were approved before apply. Each is marked **Decision** and states the choice first. Two were changed after the first build: the workflow keeps no list of bots (decision 3), and this repository replaces a fixture repository (decision 8). Three facts are still unconfirmed and are marked **To confirm**. Each has a task that settles it on this repository.

## Context

See proposal.md for the motivation. The pieces this design builds on:

- `health-code check <repo-url> --dependency <name> --to <version> --revision <sha> --upgrade-only --pull-request` already tests one named version at one commit and opens `health-code/<dependency>-<version>` (`apps/cli/src/checkRepository.ts`, `openPullRequest.ts`). It checks the name and version against the registry and the Minimum release age before any sandbox exists.
- `readRepositoryFiles` and `readLockedDependencies` in `packages/health-code/src/upgrades/` read the manifests, the lockfile and the locked version of each direct dependency per workspace at one commit, through GitHub's API, with byte and request bounds. The Upgrade menu uses them.
- `action/install-executable.sh` installs the standalone executable after the checksum and provenance checks, and requires the build of the action's own commit when the action is referenced by commit SHA.
- `scripts/releaseWorkflow.test.ts` already parses a workflow and fails when the wrong job can write or see a secret.
- An Inspection targets a public Repository. A GitHub token reads only a public repository.

What GitHub's docs say today, read on 2026-11-27 from docs.github.com and its source:

| Topic | Docs |
| --- | --- |
| Reusable workflows | Called by `{owner}/{repo}/.github/workflows/{file}@{ref}`. "Using the commit SHA is the safest option." The called workflow's token "can be only downgraded (not elevated)". The `github` context and the event payload are the caller's. Named secrets pass through `secrets:`. |
| A workflow's own commit | `job.workflow_sha` and `job.workflow_repository` name the reusable workflow's file. The docs show a reusable workflow checking out its own source with them. Not on GitHub Enterprise Server. |
| `pull_request_target` | Runs the default branch's workflow file. `GITHUB_SHA` is the default branch's last commit. Always runs, whatever the approval settings. "Avoid using this event if you need to build or run code from the pull request." |
| `workflow_run` | Runs the default branch's workflow file. "Able to access secrets and write tokens, even if the previous workflow was not." Starts whatever the previous run's conclusion. At most three levels deep. |
| Dependabot | Runs Dependabot triggers from `push`, `pull_request`, `pull_request_review` or `pull_request_review_comment` "are treated as if they were opened from a repository fork": a read-only token and Dependabot secrets only. The `permissions` key can raise the token. `pull_request_target` "does not have these limitations". A re-run keeps the first run's privileges. |
| Events from the workflow token | They start no workflow run, except `workflow_dispatch`, `repository_dispatch` and `pull_request` with `opened`, `synchronize` or `reopened`, which create runs "in an **approval-required** state" that "a user with write access to the repository can start ... by selecting **Approve workflows to run**". The docs source marks this "currently rolling out on dotcom". |
| Concurrency | One running job per group. `queue: max` lets up to 100 wait in order. The default, `single`, cancels the job that was already waiting. |

## Goals / Non-Goals

**Goals:**

- A repository adds dependency pull requests with one workflow file of about twenty lines and no script.
- Pull request content stays data from the event to the comment. The upgraded code executes only inside the sandbox.
- Every decision that reads untrusted input is TypeScript in `apps/cli/` or `packages/health-code/` with unit tests. The workflow YAML only wires steps.
- The state needs no server and no token beyond the workflow's own.

**Non-Goals:**

- Private repositories, GitHub Enterprise Server and ecosystems other than npm, pnpm, Yarn and Bun.
- CI that reports through commit statuses from another service. The Red path listens to GitHub Actions workflows.
- Pushing to the bot's branch, merging, approving or closing any pull request.
- A cap on the form. It stays a person's own spend.
- Reading a bot's configuration. The pull request's files are the only source for the target.

## Decisions

### 1. Shape: a reusable workflow, plus one composite action for the wait

**Decision.** The answer to a dependency pull request is a reusable workflow. The wait step is a composite action, because it runs inside a job of the repository's own CI, where a reusable workflow cannot.

A composite action would run inside a job the caller writes. The caller would then own the job's permissions, where the secret goes, the checkout and the concurrency. Those are the rules that must not be settings. A reusable workflow owns its jobs, can only lower the token it is given and knows its own commit through `job.workflow_sha`.

The whole caller:

```yaml
name: Health Code
on:
  pull_request_target:
    types: [opened, reopened, synchronize, labeled]
  workflow_run:
    workflows: [CI]
    types: [completed]
permissions: {}
jobs:
  dependency-pull-requests:
    if: >-
      vars.HEALTH_CODE_DEPENDENCY_PULL_REQUESTS != 'off' &&
      (github.event_name != 'workflow_run' ||
      contains(fromJSON('["failure", "timed_out"]'), github.event.workflow_run.conclusion))
    permissions:
      contents: write
      pull-requests: write
      statuses: write
      checks: read
      attestations: read
    uses: doubleoevan/health-code/.github/workflows/dependency-pull-requests.yml@<commit of the release> # v<release>
    with:
      model-host: https://api.anthropic.com
      model: claude-opus-5-5
    secrets:
      RUNTA_TOKEN: ${{ secrets.RUNTA_TOKEN }}
```

The caller changes three things: the names of its CI workflows under `workflow_run`, the model settings and any setting in the table below. The `if` line is the off switch, and it skips a CI run that did not fail, so a green run starts no job. The event field is read in the caller, so the reusable workflow still reads none. It reads the caller's own variable, which the docs define, where a variable read inside the called workflow is not documented.

The reusable workflow has two jobs:

| Job | Token | Secret | Does |
| --- | --- | --- | --- |
| `select` | read only | none | Installs the executable. Reads the event file and the pull request through the API. Decides `inspect`, `report` or `none` and writes the reason to the run summary. |
| `inspect` | the caller's grants | `RUNTA_TOKEN` | Runs only when `select` did not decide `none`. Checks out the caller's default branch with full history, never a pull request ref. Claims the mark, sets the status, runs the check, uploads the report, comments. |

Most events end in `select`: every CI completion on a human's branch, every pull request a person opens. No secret and no write token exist in those runs.

Three steps of the CLI carry the logic: `health-code dependency-pull-request select`, `inspect` and `report`. They are for this workflow and are not a stable interface. `select` passes its decision to `inspect` as job outputs. `inspect` receives them as environment variables and checks each again: an npm package name, an exact version, a 40-character commit, a number.

Both jobs install the executable the same way. They check out `job.workflow_repository` at `job.workflow_sha` into a side folder and run `action/install-executable.sh` from it with that commit as the required source digest. `install-executable.sh` gains a source path setting for this. Nothing else from the side folder executes.

A caller in another repository references the workflow by commit SHA, and the install requires the build of that commit. This repository calls it by local path, so `job.workflow_repository` is the repository of the run and `job.workflow_sha` is the default branch's head, which is rarely a release's commit. In that one case the install takes the release that `packages/health-code/package.json` names at that commit and checks its checksum and its provenance from the release workflow at the release's tag, without the commit match. The root action already works this way when it is referenced by a tag.

*Checked against GitHub.* A push-triggered caller on a throwaway branch of this repository called the workflow by local path on 2026-11-27. GitHub accepted the file, including `job.workflow_sha`, `job.workflow_repository` and `concurrency.queue: max`. The `select` job checked out the workflow's own source, installed the 0.4.0 executable after its checks and stopped at the `dependency-pull-request` command, which that release does not have.

One inspection at a time uses the job's `concurrency` with one group for the repository and `queue: max`, so a Monday of five majors runs five inspections in order. A run that only reports, such as a status copy or a cap comment, uses a group of its own and never waits behind an inspection.

*Alternatives.* A composite action only: rejected above. One job: every CI completion in the repository would start a job that holds `RUNTA_TOKEN`. A lock built on a Git reference: `queue: max` does it natively.

Settings, all inputs of the reusable workflow:

| Input | Default | Meaning |
| --- | --- | --- |
| `model-host`, `model` | required | The model settings `health-code check` reads. The optional ones pass through under the same names. |
| `major` | `true` | The Major path. |
| `red` | `true` | The Red path. |
| `red-checks` | every check | The check names that count as red. |
| `label` | `health-code` | The label of the Asked path. |
| `feature-patches` | `false` | Feature Patches on the Major and Red paths. The Asked path always includes them. |
| `weekly-cap-usd` | `25` | The spend at which a week's inspections stop. |
| `at-cap` | `comment` | `comment` adds one comment and the status. `status` sets the status only. |
| `timeout-minutes` | `75` | The job's limit. The inspection stops itself ten minutes earlier so the report step still runs. The default leaves the library's own 60-minute inspection limit to end first, which keeps a partial report and its measured cost. |
| `one-at-a-time` | `true` | One inspection at a time in the repository. |

### 2. Dependabot

**Decision.** The guide tells a repository that uses Dependabot to store `RUNTA_TOKEN` twice under the same name: as an Actions secret and as a Dependabot secret. The caller's explicit `permissions` block is the second half. With both, the workflow works whichever way GitHub treats the event.

What the docs say each event may read:

| Event | Actor | Docs | Needs |
| --- | --- | --- | --- |
| `pull_request_target` `opened` on a Dependabot pull request | `dependabot[bot]` | "Does not have these limitations." Earlier docs gave this case a read-only token and no secrets. The current page no longer says so. | The Dependabot secret and the `permissions` block cover both readings. |
| `workflow_run` after a Dependabot pull request's CI | `dependabot[bot]` | "Able to access secrets and write tokens, even if the previous workflow was not." | The same two. |
| `pull_request_target` `labeled` by a person | the person | An ordinary run. | The Actions secret. |
| A re-run of any of them | the person | "The same privileges as before." | Start again with the label, not Re-run. |

When `RUNTA_TOKEN` is empty in the inspection job, the job stops and says to add `RUNTA_TOKEN` as a Dependabot secret. When the caller grants less than the workflow's jobs ask for, GitHub rejects the run at startup and names the permission.

#### This repository

`.github/workflows/health-code.yml` is the guide's caller with `workflows: [CI]`, a local `uses: ./.github/workflows/dependency-pull-requests.yml`, the model host and model that `evaluations.yml` already names and `RUNTA_TOKEN`. It sets no other input. `.github/dependabot.yml` is unchanged: the `bun` entry groups minor and patch updates and opens each major alone. A major starts on the Major path. A grouped pull request starts on the Red path only when it holds one package or one Package family. `github-actions` pull requests start nothing.

| Needs | Where | Why |
| --- | --- | --- |
| `RUNTA_TOKEN` as an Actions secret | already set for `evaluations.yml` | Runs a person starts with the label. |
| `RUNTA_TOKEN` as a Dependabot secret, same name | Settings, Secrets and variables, Dependabot | Runs a Dependabot pull request starts. |
| The model key stored in Runta for `https://api.anthropic.com` | `npx health-code setup`, once, with the account `RUNTA_TOKEN` belongs to | The workflow passes no model key. |
| `contents: write`, `pull-requests: write`, `statuses: write`, `checks: read`, `attestations: read` | the caller's job, in the file | Raises the token Dependabot's runs get read-only by default. |
| **Allow GitHub Actions to create and approve pull requests** | Settings, Actions, General | Lets the workflow token open Health Code's pull request. |
| The `health-code` label | Issues, Labels | A label must exist before a person can add it. |

Manual steps for the maintainer, in order:

1. Before the caller reaches `main`, add the repository variable `HEALTH_CODE_DEPENDENCY_PULL_REQUESTS` with the value `off`. The released executable does not have the workflow's commands until the next release.
2. Add `RUNTA_TOKEN` as a Dependabot secret with the same value as the Actions secret.
3. Run `npx health-code setup` once with that Runta account and `HEALTH_CODE_MODEL_HOST=https://api.anthropic.com`, unless the key is already stored there.
4. Turn on **Allow GitHub Actions to create and approve pull requests**.
5. Create the `health-code` label.
6. After the release that holds this change publishes its executables, delete the variable.
7. When the first Dependabot pull request has its comment, put its link in the README.

**To confirm** on this repository's own Dependabot pull requests: the token and the secrets each of the two events gets, with and without the Dependabot secret. The guide then states the observed fact. Renovate is an ordinary GitHub App and has no such limits in the docs.

### 3. The target command

**Decision.** `health-code target <pull-request-url>` prints one JSON object and exits zero whether it found a target or a reason. It exits nonzero only when GitHub could not be read. The inspection runs at the pull request's base commit, not at the default branch's head.

A target:

```json
{
  "pullRequest": 123,
  "author": "renovate[bot]",
  "headCommit": "…",
  "baseCommit": "…",
  "upgrade": { "dependency": "react", "from": "18.3.1", "to": "19.0.0", "kind": "major" },
  "isMajor": true,
  "movedWith": [{ "dependency": "react-dom", "from": "18.3.1", "to": "19.0.0" }]
}
```

A reason:

```json
{ "pullRequest": 124, "author": "dependabot[bot]", "reason": "grouped", "message": "The pull request moves 6 unrelated packages." }
```

The reasons are a fixed list: `fork`, `own-pull-request`, `other-changes`, `no-npm-dependency`, `no-direct-dependency`, `grouped`, `mixed-versions`, `not-an-upgrade` and `unreadable`. Each message is fixed copy with at most a count.

How it reads the pull request, in the library as `readPullRequestTarget`:

1. One request for the pull request. The head repository must be the base repository. A head branch under `health-code/` is Health Code's own. The author and the branch name are never read for trust: `author` in the output is information only.
2. One compare request for the merge base of the head with the base branch. That commit is the **base commit**. `pull_request.base.sha` is not used, because it can lag the branch. The compare also lists the changed files. A dependency pull request changes only manifests, lockfiles and files the package manager generates: Yarn's `.yarn/cache/`, its install state and a root `.pnp.*` file. A renamed file counts under both names. No such file gives `no-npm-dependency`. Any other file gives `other-changes`, and so does a list cut short at 300 files.
3. `readRepositoryFiles` and `readLockedDependencies` at the base commit and at the head. The two results differ in the locked versions of direct dependencies. That difference is the bot's change, and a manifest that did not change still counts when the lockfile moved a direct dependency.
4. One moved dependency is the target. Several form a **Package family** when they share one npm scope or all move to the same version. The family's lead is its member with the highest upgrade kind, then the first by name. The others are `movedWith`. Anything else is `grouped`.
5. `isMajor` is true for a major upgrade, and for a minor upgrade from a version below 1.0. `toUpgradeKind` already names the kind.

*Checked against GitHub.* The built executable read four live pull requests: a Dependabot action bump (`no-npm-dependency`), a Dependabot group of nine (`grouped`), a Renovate ESLint group (`grouped`) and a Dependabot `typescript` 5.4.5 to 7.0.2 major, which returned the target with its merge base.

*Why the changed files and not the author.* A list of bot logins is not a security boundary: a fork is excluded by its head repository, and anyone who opens a pull request from a branch of the repository can already write to it. The list only kept the automatic paths off a person's feature branch that also bumps a dependency. The content rule does that without a setting, works for a self-hosted bot unchanged and lets a person's own dependency bump be inspected like a bot's. Health Code's own pull requests are dependency-only too, which is why the `health-code/` branch check stays.

*Why the base commit.* It is the commit the bot's change is measured from, so the versions the target names are the versions the inspection sees. It is the commit whose checks decide the Red path. It keeps the form and its existing spec scenario as they are. *Trade-off:* on a pull request that is weeks behind its base branch, the Patch is tested on an old commit and Health Code's pull request can conflict in the lockfile. The comment names the tested commit. The guide says to have the bot rebase first, then add the label. *Alternative:* the base branch's head. It gives a Patch that merges cleanly more often, and it breaks the three properties above.

*Why scope or same version for a family.* It needs no registry request and no list of presets. `react` with `react-dom` and `eslint` with `@eslint/js` match on the version. `@babel/core` with `@babel/preset-env` match on the scope. Two unrelated packages that both reach 2.0.0 would pass as a family, and the comment then says which package the Patch left. Matching on the source repository in the registry record is the upgrade if families are missed.

### 4. Where state lives

**Decision.** Git references under `refs/health-code/` in the caller's repository, written through GitHub's API with the workflow token.

| State | Reference | Write |
| --- | --- | --- |
| **Inspection mark**: one per dependency and version | `refs/health-code/inspections/<SHA-256 of name@version>` | Created when an inspection starts. Creation fails when the reference exists, so two runs cannot both claim it. Finished with a second commit that records the Verdict, the links and the cost. |
| Weekly spend | `refs/health-code/spend/<ISO week>/<commit>` | One reference per inspection, created once with that inspection's cost. The week's total is the sum of the week's records. No run updates another run's reference. |

Each record is JSON in a commit message. The commit reuses the base commit's tree, so no file is written. References outside `refs/heads/` and `refs/tags/` show in no branch or tag list, start no workflow and need only `contents: write`, which the Patch branch already needs. The digest keeps a package name out of the reference name, where characters such as `~` are not allowed.

The Red and Major paths start nothing when the mark exists. The Asked path starts anyway and replaces the mark's record. The cap is checked before the claim. The cost is known only after an inspection, so the week can pass the cap by one inspection. An inspection that leaves no measured cost counts its cost limit: the report's own limit, or the library's $15 default when there is no report.

*Alternatives.* A comment on the bot's pull request: lost when the bot opens a new pull request for the same version. A commit status: tied to one head commit, lost on a rebase. Artifacts: written at the end, so two runs can both start, and they expire. A branch with a file: shows in the branch list and has no atomic claim. A repository variable: the workflow token cannot write one.

**Confirmed** on this repository on 2026-11-27, with a push-triggered workflow on a throwaway branch and the workflow token at `contents: write`:

| Call on `refs/health-code/check-<run>` | Result |
| --- | --- |
| Create | Accepted |
| Create again | Refused with 422, "Reference already exists" |
| Read, and list by prefix | Accepted |
| Update forward without force | Accepted |
| Update backward without force | Accepted. GitHub does not refuse a non-fast-forward update outside `refs/heads/`. |
| Delete | Accepted |

So a create-once claim is safe and a compare-and-swap update is not. The mark only needs the first. The weekly spend was first built as one reference updated fast-forward only, which this result rules out, and it now writes one reference per inspection.

### 5. How a repository's CI waits on a major

**Decision.** Every inspection reports a commit status named `health-code` on the bot's pull request head. The wait step polls that status. It ends when the status leaves `pending`, whatever the result, and by default the job then continues.

| Status | When |
| --- | --- |
| `pending` | The inspection started. |
| `success` | Verdict Passes as is, Fixed or Fixed with test changes. |
| `failure` | Verdict Can't fix. |
| `error` | Verdict Untested, or no inspection: the version was rejected, the cap is reached or the inspection did not finish. The description says which. |

The wait step:

```yaml
- uses: doubleoevan/health-code/action/wait@<commit of the release> # v<release>
- run: npm ci
```

It installs the executable from its own commit and runs `health-code wait`. The command reads the job's `pull_request` event and the target. It returns at once for anything that is not a dependency pull request with one major upgrade, so jobs on other pull requests lose a few seconds. For a major it polls until the status on the head commit is no longer `pending`.

| Input | Default | Meaning |
| --- | --- | --- |
| `timeout-minutes` | `75` | How long it waits for a status. |
| `require-inspection` | `false` | When true, the step fails on `error` and on a timeout, so nothing installs a major the sandbox did not try. |

The wait reads the target itself because its job starts within seconds of the pull request, before any status exists. It cannot treat a missing status as no inspection.

A rebase gives the pull request a new head with no status. The caller listens for `synchronize`, and the workflow copies the mark's result to the new head without an inspection. That run never waits behind an inspection. A new head of a major that has no mark starts the Major path as an opened pull request does, so a major that opened at the cap is inspected after its next rebase.

A cancelled or failed job still ends the wait: the report step runs on every outcome and sets `error`. A job that never starts leaves the wait to its timeout. With the Major path or the workflow turned off, remove the wait step or give it the same `if`.

*Alternative.* Poll the mark: it survives a rebase, and it cannot say that the cap was reached, because no mark is claimed then.

### 6. CI on Health Code's own pull request

**Decision.** The guide says: CI on Health Code's pull request waits for a person. Open the pull request and select **Approve workflows to run**. Review the Patch first, since approval runs it on your runners.

The docs confirm it: a pull request created with the workflow token creates `pull_request` runs in an approval-required state, and a user with write access starts them. The docs source marks the rule as still rolling out. Where it has not arrived, the pull request starts no CI at all, and closing and reopening it as a person starts CI. The guide says both. The existing guide sentence "With `github.token` the pushed branch starts no other workflow" is replaced.

Health Code's pull requests never start the dependency pull request workflow. `select` returns `own-pull-request` for a head branch under `health-code/`, before any file is read. Their CI finishing reaches `select` as a `workflow_run` and ends the same way. The `labeled` events the workflow token causes start no run.

**To confirm** on this repository's first Health Code pull request: which of the two behaviors it has today.

### 7. A grouped or non-npm dependency pull request

**Decision.** Nothing on the bot's pull request on the automatic paths. The reason is in the workflow run's summary. On the Asked path a person asked, so the pull request gets one comment with the reason, and the label is removed.

A repository with weekly action and image bumps would otherwise collect a comment on every one. The label is removed after every Asked run, so adding it again is how a person asks again.

What each bot does once Health Code's pull request merges: Renovate's docs say it "either autocloses the PR and deletes the branch, or, if the branch has been modified, flags the PR as abandoned". Dependabot closes a pull request whose dependency is already up to date on its next run. The docs page read for this design does not state it. **To confirm** Dependabot's on this repository, then state it in the guide. This repository runs no Renovate, so the guide states Renovate's behavior from its docs.

### 8. This repository is the live check

**Decision.** No fixture repository and no scripted live test. This repository's own Dependabot pull requests exercise the released workflow, and the maintainer checks the first major after a release by hand: one status, one comment, one Health Code pull request, one mark, and nothing new after a CI re-run. `DEVELOPMENT.md` lists the check.

A scripted test on this repository would leave a pull request, a branch and a comment in the public history on every run, would delete real marks and the real week's spend in its cleanup and would spend from the real cap. A separate fixture repository avoids those and costs a second repository, its secrets and a token to maintain, to re-prove a flow this repository's own pull requests exercise every week.

*Trade-off.* Nothing re-proves the whole flow on a later release except this repository's pull requests continuing to work. A break shows here first.

### The comment

One comment per dependency pull request, found again by a hidden marker and replaced on a later inspection. It is fixed copy plus these values: the dependency name and versions the target command checked against npm's grammar, the base commit, the Verdict, the three Check Result statuses, the number of Health Code's pull request, the two costs from `runtimeUsage` and the artifact link the upload step returns.

- No tested Patch: a fixed sentence chosen by the Verdict and the first check that did not pass. The report's free-text reason is not copied.
- A difference in moved packages: the target's `movedWith` compared with the upgrade and the linked dependencies in the report. The comment names each package the Patch moves that the bot's pull request does not, and each one the bot moved that the Patch leaves.
- Customer copy says "the health inspector" and uses no Oxford comma.

## Changes from the ship review

- **The report step attempts every write.** The status, the spend, the mark and the comment are written independently, so one failed write leaves no pending status, uncounted cost or unfinished mark. The step still fails afterwards.
- **A re-run ends what it started.** The mark records the workflow run's ID. A re-run of the same run takes over its own unfinished mark, where it would otherwise find the mark claimed and do nothing.
- **A head that moved during the inspection gets the status too, when it holds the same upgrade.** The report step reads the pull request's target again and sets the status on the new head only when the dependency, the version and the base commit match.
- **A lost claim needs the reference to exist.** GitHub also answers 422 to a request it cannot validate, so the step confirms the mark's reference before it stands down.
- **The comment is its own write.** A failed lookup of Health Code's pull request no longer stops the status, the spend or the mark.
- **A status is copied only to the pull request the mark belongs to.**
- **The wait polls every 30 seconds and treats a failed poll as no status yet,** so five waiting jobs stay inside the workflow token's request limit and one network error does not fail a caller's CI.
- **The inspect step runs through `exec`,** so the runner's cancel signal reaches the command and its sandboxes are deleted.
- **`select` checks its own decision** with the schema the later steps use. A pull request whose versions are not plain releases starts nothing.
- **The installer stops when another repository's call names no commit,** where it would otherwise fall back to the weaker check.
- **A rejected version's sentence is shown as plain text,** so a scoped package name mentions nobody.

Anyone with push access can write or delete references under `refs/health-code/`, as they can any branch.

## Risks / Trade-offs

- [The Red path needs a green check on the base commit. A repository whose CI runs only on `pull_request` has none, so the Red path starts nothing there.] → The run summary says that no check on the base commit matched. The guide says to run CI on pushes to the base branch too. Counting a check with no result on the base commit is the alternative, at the cost of inspections for failures the base branch already has.
- [`queue: max`, `job.workflow_sha` and approval-required runs are recent GitHub features.] → The workflow targets github.com. GitHub validates the file on the first push, and this repository's own pull requests fail first if it rejects a keyword.
- [GitHub does not protect a reference outside `refs/heads/` from a non-fast-forward update.] → Nothing relies on it: the mark is claimed by creating a reference, and each cost record is created once. A record's reference is named after its own commit.
- [The cap can be passed by one inspection, or by several with `one-at-a-time` off.] → The guide says so. The default keeps it to one.
- [An upgrade that passes as is has a tested patch that only repeats the original pull request.] → No pull request is opened for it. The comment says the upgrade passed as is. Health Code's pull request appears only when the patch holds a repair.
- [A person pushes commits to the bot's branch.] → The target reads the head's files as data, whoever wrote them. Nothing from the head executes outside the sandbox.
- [A package name reaches a comment.] → Only names that pass npm's grammar are printed, inside code spans. The grammar has no backtick, bracket or angle bracket.
- [This repository calls the workflow by local path, so the workflow file on `main` can be newer than the released executable it installs.] → The repository variable holds the workflow off until the first release with its commands. After that a mismatch shows on this repository's own pull requests first, and the next release ends it.
- [`select` runs on every completion of the listed CI workflows.] → It reads the event file first and makes no request for a run that is not a failed pull request run.

## Migration Plan

1. Ship in the next release. Existing callers of `check` and the install action change nothing.
2. After the tag's executables publish, delete the off variable and check the first Dependabot major on this repository as `DEVELOPMENT.md` describes.
3. Add the release's commit to the CI guide's table.

Rollback for a caller is the repository variable or removing the caller file. The references under `refs/health-code/` can be deleted at any time: the next qualifying event inspects again.

## Open Questions

- The dollar default of `weekly-cap-usd`. $25 covers about five upgrade-only inspections at the repair limit of $4 each. The first weeks on this repository will show whether it is right.
