# Proposal

## Why

Health Code exists for a pile of dependency pull requests where each one still needs someone to find out what broke. Today the CI guide answers that with a form: a person copies the package, the version and the base commit from a failing pull request into Run workflow. Wiring the bot's own events to an inspection is the hard part, and every repository would build it again: a job that holds `RUNTA_TOKEN` and a write token while it reads a bot's branch names, titles and files, which it must never execute. Health Code builds it once, with tests, so a repository adds it by reference and changes only settings.

## What Changes

- **A reusable workflow** at `.github/workflows/dependency-pull-requests.yml`. A repository adds one short workflow that names the triggers and calls it by commit SHA with `RUNTA_TOKEN` and the model settings. The caller writes no script.
- **Any dependency pull request, whoever opened it.** The workflow answers a pull request from a branch of the repository that changes only package manifests and lockfiles. It keeps no list of bots, so Renovate, Dependabot, a self-hosted bot and a person's own bump are treated alike.
- **Four ways an inspection starts.** Major: a bot opens a pull request for a major upgrade of one package or one package family, or a minor upgrade of a package below 1.0. Red: the repository's CI finishes red on any other single-upgrade dependency pull request, on a check that is green on the base commit. Asked: a person with write access adds the `health-code` label. By hand: the form in the CI guide stays.
- **A target command**, `health-code target <pull-request-url>`. It reads the manifests and the lockfile at the pull request's base commit and head through GitHub's API and the shared locked dependency module. It prints the dependency, the version the head installs, the base commit, whether the upgrade counts as a major and the packages that moved with it, or the reason there is no single upgrade. It never checks out or executes the pull request.
- **One inspection, one comment.** The workflow runs the check for that dependency and version at the base commit, with the upgrade Patch only on the Major and Red paths. The tested Patch becomes Health Code's own pull request on `health-code/<dependency>-<version>`. The bot's pull request gets one comment built from fixed copy and Inspection Report fields, and a `health-code` commit status on its head.
- **Rules that are not settings.** No step checks out the pull request. No run step holds a workflow expression. One job holds `RUNTA_TOKEN` and every write permission. The workflow installs the executable of its own commit after the checksum and provenance checks. A dependency and version is inspected once per repository until a person asks again. Health Code's own pull requests and their CI start nothing.
- **Settings with defaults:** the Major path, the Red path and its checks, the label name, feature Patches on the automatic paths, a weekly spend cap and what a pull request gets at the cap, the time limit and one inspection at a time. A repository variable turns the workflow off without an edit.
- **A wait step**, `doubleoevan/health-code/action/wait`. A repository puts it before its install so the sandbox tries a major before CI installs it.
- **State without a server.** The one-per-version mark and the week's spend live in Git references under `refs/health-code/` in the caller's repository.
- **This repository adopts it.** `.github/workflows/health-code.yml` is the guide's caller for this repository's own Dependabot pull requests. It calls the reusable workflow by local path and passes `RUNTA_TOKEN` and the model settings only. `.github/dependabot.yml` stays as it is, so each major arrives alone and starts an inspection, and a grouped minor and patch pull request starts one only when it holds a single package. The README says so and links one such pull request.
- **Docs.** The CI guide leads with dependency pull requests, then the weekly schedule, then the form. It shows the whole caller, the settings table, the permissions and the wait step. The README's CI section points to it.
- **Tests.** Unit tests cover the target command on every fixture, the start decision, the mark and the cap. A test reads the reusable workflow and fails on a pull request checkout, an expression in a run step, a secret or write permission outside the inspection job, or an action referenced by anything other than a commit SHA. This repository's own Dependabot pull requests are the live check: the maintainer checks the first major after a release.

Nothing in this change breaks an existing command, option or workflow.

## Capabilities

### New Capabilities

- `dependency-pull-requests`: the reusable workflow that answers a Renovate or Dependabot pull request. It owns which events start an inspection, the rules that keep pull request content as data, the settings, the comment and status on the bot's pull request, the wait step, the one-per-version mark and the weekly spend cap.

### Modified Capabilities

- `ci-inspections`: adds the `health-code target` command, which reads the upgrade a pull request holds without a checkout or a sandbox. No existing requirement changes.

## Impact

- `packages/health-code/`: a public function that reads a pull request's upgrade target through the GitHub session and the locked dependency module the Upgrade menu uses. Requests go to GitHub's API origin only.
- `apps/cli/`: the `target` command, the three `dependency-pull-request` steps the workflow runs (select, inspect, report) and their tests. `check` keeps its arguments.
- `.github/workflows/dependency-pull-requests.yml`: new, called by other repositories. Only its inspection job holds a secret or a write permission.
- `.github/workflows/health-code.yml`: new, this repository's caller. It needs `RUNTA_TOKEN` as a Dependabot secret, the pull request setting and the `health-code` label, which the maintainer adds by hand.
- `action/`: the wait step and a source path setting on `install-executable.sh`, so the workflow and the wait step install from their own commit.
- `scripts/`: the workflow rules test, beside `releaseWorkflow.test.ts`.
- Docs: `apps/cli/README.md`, the root README, the root and module `AGENTS.md` files, `DEVELOPMENT.md` and the domain-model skill (Dependency pull request, Package family, Inspection mark, Start path).
- Callers: public repositories only, as every Inspection. A caller grants `contents: write`, `pull-requests: write`, `statuses: write`, `checks: read` and `attestations: read`, and turns on **Allow GitHub Actions to create and approve pull requests**.
