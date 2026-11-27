# dependency-pull-requests Specification

## Purpose
Let a public Repository answer a Renovate or Dependabot pull request with an Inspection of the upgrade it holds, from a reusable workflow the repository adds by reference and configures only through settings.

## Requirements

### Requirement: Add the workflow by reference

The repository SHALL provide a reusable workflow that a caller adds with one workflow file: the triggers, a call by commit SHA, `RUNTA_TOKEN` and the model settings. The caller SHALL write no script. The CI guide SHALL show the whole caller.

#### Scenario: A repository adds dependency pull requests

- **WHEN** a public repository commits the caller from the CI guide with its own CI workflow names and model settings
- **THEN** dependency pull requests start inspections with every other setting at its default

#### Scenario: A green CI run

- **WHEN** a listed CI workflow finishes without a failure
- **THEN** no job of the workflow starts

#### Scenario: A repository turns it off

- **WHEN** the repository variable `HEALTH_CODE_DEPENDENCY_PULL_REQUESTS` is `off`
- **THEN** no job of the workflow starts and no file was edited

### Requirement: Start on a major upgrade

The workflow SHALL start an Inspection when a pull request opens whose target is a major upgrade of one package or one Package family, or a minor upgrade of a package below 1.0. It SHALL start when the pull request opens, without waiting for the repository's CI.

#### Scenario: A major

- **WHEN** Renovate opens a pull request that moves `react` from 18.3.1 to 19.0.0
- **THEN** an Inspection of `react` 19.0.0 starts at the pull request's base commit

#### Scenario: A minor below 1.0

- **WHEN** a bot opens a pull request that moves a package from 0.4.2 to 0.5.0
- **THEN** an Inspection starts as for a major

#### Scenario: A patch below 1.0

- **WHEN** a bot opens a pull request that moves a package from 0.4.2 to 0.4.3
- **THEN** no Inspection starts when the pull request opens

#### Scenario: The Major path is off

- **WHEN** the caller sets `major` to false and a bot opens a major upgrade
- **THEN** no Inspection starts when the pull request opens, and the Red path still applies

### Requirement: Start on red CI

The workflow SHALL start an Inspection when a listed CI workflow finishes on a dependency pull request with a single upgrade and a check failed that succeeded on the pull request's base commit. With `red-checks` set, only the named checks SHALL count.

#### Scenario: CI fails on a minor upgrade

- **WHEN** the `test` check fails on a Dependabot pull request for one package and `test` succeeded on the base commit
- **THEN** an Inspection of that package and version starts

#### Scenario: The base branch already fails

- **WHEN** the only failed check on the pull request also failed on the base commit
- **THEN** no Inspection starts

#### Scenario: The base commit has no result for the check

- **WHEN** no check on the base commit has the failed check's name
- **THEN** no Inspection starts and the run summary says that no check on the base commit matched

#### Scenario: A check outside the list

- **WHEN** `red-checks` names `test` and only `lint` failed
- **THEN** no Inspection starts

#### Scenario: CI passes

- **WHEN** the CI workflow finishes green on a dependency pull request
- **THEN** no Inspection starts

### Requirement: Start when a person asks

The workflow SHALL start an Inspection when a person with write access adds the configured label to a dependency pull request with a single upgrade, whether its CI is red or green and whether the version was inspected before. It SHALL remove the label when it has answered.

#### Scenario: A person adds the label

- **WHEN** a maintainer adds `health-code` to a green dependency pull request for one package
- **THEN** an Inspection starts with Code Feature Matches and Feature adoption, and the label is removed when it ends

#### Scenario: The version was inspected before

- **WHEN** a maintainer adds the label to a pull request whose dependency and version already have an Inspection mark
- **THEN** a new Inspection starts and its result replaces the mark's record and the comment

#### Scenario: A person without write access

- **WHEN** a user whose permission is below write adds the label
- **THEN** no Inspection starts

#### Scenario: Another label

- **WHEN** any other label is added
- **THEN** no Inspection starts

### Requirement: Leave other pull requests alone

The workflow SHALL start no Inspection for a pull request from a fork, from a branch Health Code pushed, with changes to files other than package manifests and lockfiles, with several unrelated packages or with no direct npm dependency change. On the automatic paths it SHALL write the reason to the run summary and nothing to the pull request. On the Asked path it SHALL comment once with the reason.

#### Scenario: A grouped pull request

- **WHEN** a bot opens a pull request that moves six unrelated packages
- **THEN** no Inspection starts, the pull request gets no comment and no status, and the run summary says the pull request is grouped

#### Scenario: An action or image bump

- **WHEN** a bot opens a pull request that changes only a workflow file or a Dockerfile
- **THEN** no Inspection starts and the pull request gets nothing

#### Scenario: A fork's branch named like a bot's

- **WHEN** a fork opens a pull request from a branch named `renovate/react-19.x`
- **THEN** no Inspection starts and no job that holds a secret runs

#### Scenario: A person's dependency bump

- **WHEN** a maintainer opens a pull request from a branch of the repository that changes only `package.json` and the lockfile for one major upgrade
- **THEN** an Inspection starts as it does for a bot's pull request

#### Scenario: A feature branch that also bumps a dependency

- **WHEN** a pull request changes source files and moves one dependency
- **THEN** no Inspection starts on the automatic paths and the run summary says the pull request has other changes

#### Scenario: Health Code's own pull request

- **WHEN** a pull request from a `health-code/` branch opens, or its CI finishes red
- **THEN** no Inspection starts, although it changes only package files

#### Scenario: A person asks on a grouped pull request

- **WHEN** a maintainer adds the label to a grouped dependency pull request
- **THEN** the pull request gets one comment that says why there is no single upgrade, and the label is removed

### Requirement: Keep pull request content as data

The workflow SHALL never check out or execute a pull request's code on the runner. No run step SHALL contain a workflow expression. Every value that came from the pull request SHALL reach a command as an environment variable or an argument and be checked before use: the package name and version against npm's grammar, a commit as 40 hexadecimal characters. The upgraded code SHALL execute only inside the sandbox.

#### Scenario: A crafted branch name or title

- **WHEN** a pull request's branch name or title holds shell syntax
- **THEN** no step interpolates it, and the run behaves as for any other name

#### Scenario: A crafted package name

- **WHEN** a manifest at the head declares a dependency whose name fails npm's grammar
- **THEN** that name reaches no command argument, comment or reference

#### Scenario: The workflow file is checked

- **WHEN** a step of the reusable workflow or the wait step checks out a pull request ref, or a run step contains a workflow expression
- **THEN** a repository test fails

### Requirement: Hold the secret and the write permissions in one job

Exactly one job of the workflow SHALL receive `RUNTA_TOKEN` and write permissions. Every other job SHALL run with a read-only token and no secret. Every action the workflow uses SHALL be referenced by commit SHA.

#### Scenario: An event that starts nothing

- **WHEN** a CI workflow finishes on a person's branch
- **THEN** the run ends in a job with a read-only token and no secret

#### Scenario: The workflow file is checked

- **WHEN** a job other than the inspection job references a secret or holds a write permission, or an action is referenced by a tag or a branch
- **THEN** a repository test fails

### Requirement: Explain a missing permission or secret

The workflow SHALL stop before any Inspection when a permission or `RUNTA_TOKEN` is missing, with a message that names what is missing and where to set it. The CI guide SHALL list the permissions the caller grants.

#### Scenario: A missing permission

- **WHEN** the caller's job omits `statuses: write`
- **THEN** the run stops at startup and the error names the permission

#### Scenario: A Dependabot pull request without the Dependabot secret

- **WHEN** `RUNTA_TOKEN` is empty in a run that a Dependabot pull request started
- **THEN** the job stops and says to add `RUNTA_TOKEN` as a Dependabot secret

#### Scenario: Pull requests from Actions are blocked

- **WHEN** the repository does not allow GitHub Actions to create pull requests
- **THEN** the comment and the job name the setting to turn on

### Requirement: Install the executable of the workflow's own commit

Each job SHALL install the standalone executable released from the commit the caller referenced, after the checksum and build provenance checks the install action makes. A failed check SHALL stop the job before any command runs.

#### Scenario: Called at a release commit

- **WHEN** a caller references the workflow at a release's commit
- **THEN** each job runs that release's executable

#### Scenario: A tag moved to another commit

- **WHEN** the executable's provenance names a different commit than the one the caller referenced
- **THEN** the job fails and nothing reaches `PATH`

#### Scenario: Called by local path

- **WHEN** this repository calls the workflow by local path at a commit that is not a release's commit
- **THEN** each job installs the release that commit's package version names, after the checksum check and the provenance check against that release's tag

### Requirement: Inspect a dependency and version once

The workflow SHALL record an Inspection mark for a dependency and version in the caller's repository when an Inspection starts. The Major and Red paths SHALL start nothing when the mark exists. Only the Asked path and the form SHALL inspect the same dependency and version again. The mark SHALL need no service or token beyond the workflow's own.

#### Scenario: A second red CI

- **WHEN** CI finishes red again on a pull request whose dependency and version are marked
- **THEN** no Inspection starts and the pull request gets no second comment

#### Scenario: A rebase

- **WHEN** the bot rebases a pull request whose dependency and version are marked
- **THEN** no Inspection starts

#### Scenario: Two events at once

- **WHEN** two runs for the same dependency and version reach the inspection job together
- **THEN** one claims the mark and inspects, and the other ends without an Inspection

#### Scenario: The bot opens a new version

- **WHEN** the bot replaces the pull request with one for a newer version
- **THEN** that version has no mark and can start an Inspection

### Requirement: Check the upgrade and open Health Code's pull request

The workflow SHALL run the check for the target's dependency and version at the pull request's base commit and open the tested Patch as a pull request on `health-code/<dependency>-<version>` when the Verdict is not Passes as is. On the Major and Red paths it SHALL test the upgrade only, unless the caller turns feature Patches on. It SHALL change nothing on the bot's branch.

#### Scenario: The upgrade is repaired

- **WHEN** the Inspection ends with the Verdict Fixed
- **THEN** Health Code's pull request holds the upgrade Patch and the bot's branch is unchanged

#### Scenario: The upgrade passes as is

- **WHEN** the Inspection ends with the Verdict Passes as is
- **THEN** no pull request is opened and the comment says the upgrade passed as is

#### Scenario: Feature Patches are on

- **WHEN** the caller sets `feature-patches` to true and the Red path starts an Inspection
- **THEN** the check also runs Code Feature Matches and Feature adoption

#### Scenario: The version is rejected

- **WHEN** the head installs a version the Minimum release age does not allow yet
- **THEN** no sandbox is allocated and the comment says the version was rejected and why

### Requirement: Comment once on the bot's pull request

The workflow SHALL keep one comment on the bot's pull request with the Verdict, the install, typecheck and test results, the link to Health Code's pull request or why there is no tested Patch, the model cost, the sandbox cost and the link to the saved Inspection Report. The comment SHALL hold only fixed copy and values the Inspection Report or the target sets: no release note text, no model text and no command output.

#### Scenario: An Inspection ends

- **WHEN** an Inspection ends with a tested Patch
- **THEN** the bot's pull request has one comment with every listed field and the link to Health Code's pull request

#### Scenario: No tested Patch

- **WHEN** the Verdict is Can't fix
- **THEN** the comment gives a fixed sentence for why no tested Patch is available and still links to the Inspection Report

#### Scenario: The Patch moves different packages

- **WHEN** the Patch moves a linked dependency the bot's pull request did not, or leaves a package the bot's pull request moved
- **THEN** the comment names each such package and says which side moved it

#### Scenario: A later Inspection

- **WHEN** a person adds the label after an earlier Inspection commented
- **THEN** the same comment is replaced and no second one is added

### Requirement: Report the inspection on the pull request head

The workflow SHALL set a commit status named `health-code` on the bot's pull request head: `pending` when an Inspection starts, then `success` for Passes as is, Fixed or Fixed with test changes, `failure` for Can't fix, and `error` for Untested or when no Inspection ran. A cancelled or failed job SHALL still end the status.

#### Scenario: An Inspection runs

- **WHEN** an Inspection starts and later ends with the Verdict Fixed
- **THEN** the head shows `pending` and then `success` with the Verdict

#### Scenario: The job is cancelled

- **WHEN** the inspection job is cancelled or fails after the status is `pending`
- **THEN** the status becomes `error` and says the Inspection did not finish

#### Scenario: A rebase after an Inspection

- **WHEN** the bot pushes a new head to a pull request whose dependency and version are marked
- **THEN** the new head gets the mark's result as its status, with no Inspection and without waiting behind a running one

### Requirement: Wait for the inspection before installing

The repository SHALL provide a wait step for a caller's own CI job. On a pull request whose target is a major it SHALL wait until the `health-code` status on the head is no longer `pending`, then let the job continue. On any other event it SHALL return at once. With `require-inspection` it SHALL fail the step when the status is `error` or none arrives within its time limit.

#### Scenario: A major is inspected first

- **WHEN** a pull request opens with one major upgrade and the repository's install job starts with the wait step
- **THEN** the install runs after the Inspection's status leaves `pending`

#### Scenario: Another pull request

- **WHEN** the job runs for a pull request with no dependency upgrade, or with a patch upgrade
- **THEN** the wait step returns at once

#### Scenario: The cap is reached

- **WHEN** the status is `error` because the weekly cap is reached
- **THEN** the job continues with a warning, or fails when `require-inspection` is true

#### Scenario: No status arrives

- **WHEN** no status leaves `pending` within the wait step's time limit
- **THEN** the job continues with a warning, or fails when `require-inspection` is true

### Requirement: Cap the week's spend

The workflow SHALL keep the running model and sandbox cost of the week's Inspections in the caller's repository and start none on any of its paths once the total reaches `weekly-cap-usd`. A pull request that would have started one SHALL get the `error` status, and one comment unless `at-cap` is `status`. The form SHALL stay outside the cap.

#### Scenario: Under the cap

- **WHEN** the week's total is below the cap
- **THEN** an Inspection starts and its cost is added when it ends

#### Scenario: At the cap

- **WHEN** the week's total has reached the cap and a bot opens a major
- **THEN** no Inspection starts, no mark is recorded, the status says the cap is reached and the pull request gets one comment

#### Scenario: A new week

- **WHEN** a new ISO week starts and the pull request's CI finishes red again or a person adds the label
- **THEN** the total starts from zero and the Inspection can start

#### Scenario: An Inspection without a measured cost

- **WHEN** an Inspection ends without a cost in its report
- **THEN** the week's total grows by that Inspection's cost limit

### Requirement: Apply the caller's settings

The workflow SHALL accept these settings, each with a default: the Major path (on), the Red path (on) and its checks (all), the label (`health-code`), feature Patches on the automatic paths (off), the weekly cap ($25) and what a pull request gets at the cap (a comment), the time limit (75 minutes) and one Inspection at a time (on).

#### Scenario: Several majors at once

- **WHEN** a bot opens five major pull requests in a minute with `one-at-a-time` on
- **THEN** five Inspections run one after another and none is dropped

#### Scenario: The time limit

- **WHEN** an Inspection reaches the time limit
- **THEN** it stops, deletes its sandboxes and the status and comment say it did not finish

### Requirement: Answer this repository's own Dependabot pull requests

This repository SHALL run the workflow on its own Dependabot pull requests through the CI guide's caller. The caller SHALL call the reusable workflow by local path and pass `RUNTA_TOKEN` and the model settings only. The repository's Dependabot configuration SHALL stay as it is. The README SHALL say that Health Code runs on its own Dependabot pull requests and link one.

#### Scenario: A major arrives alone

- **WHEN** Dependabot opens a pull request for one major upgrade of a `bun` dependency
- **THEN** an Inspection of that dependency and version starts

#### Scenario: A grouped minor and patch pull request

- **WHEN** Dependabot opens the weekly grouped pull request with several unrelated packages
- **THEN** no Inspection starts

#### Scenario: A grouped pull request with one package

- **WHEN** the weekly grouped pull request holds one package and the `gate` check fails on it
- **THEN** an Inspection of that package and version starts

#### Scenario: The caller is checked

- **WHEN** the caller references an action by anything but a commit SHA, references a secret other than `RUNTA_TOKEN` or checks out a pull request ref
- **THEN** a repository test fails
