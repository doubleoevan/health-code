# Health Code in CI

[npm](https://www.npmjs.com/package/health-code) · [GitHub](https://github.com/doubleoevan/health-code) · [Demo](https://runhealthcode.dev)

Try a dependency upgrade on a public GitHub repository from a CI job. On the CI machine, the command reads GitHub and the npm registry to decide what to test. The upgraded code then runs in one Runta sandbox on your own Runta account. Your pipeline receives an Inspection Report and a pull request with the tested patch. Start with [dependency pull requests](#dependency-pull-requests) to answer Renovate and Dependabot on their own, the [weekly schedule](#weekly-schedule) to try one upgrade every Monday or [the form](#by-hand) to test one by hand.

## Install

Pipelines run the standalone executable. It is one file for Linux x64, Linux arm64 or macOS arm64, built from the release's locked dependencies. The job that holds your Runta token installs no npm packages and needs no Node. The executable needs nothing else on the machine except `git` and `gh` for `--pull-request`.

### GitHub Actions

```yaml
- uses: doubleoevan/health-code@<commit of v0.4.0> # v0.4.0
- run: health-code check https://github.com/${{ github.repository }}
```

The action downloads the executable for the runner, checks it against the release checksum and verifies its build provenance. Only then does it put `health-code` on `PATH`. It installs the release of the commit you use and requires that the release workflow built the executable from that commit, so refer to the action by the commit of a release tag with the version in a comment. Dependabot and Renovate keep that line current. Find the commit with `git ls-remote https://github.com/doubleoevan/health-code refs/tags/v0.4.0`. Set the `version` input to install another release. The action fails on any other runner and names the npx command.

The action reads releases and attestations with `github.token`. A workflow that sets `permissions` grants `attestations: read` for the check.

### Verify a download

Other CI systems download one exact version. Each release includes the executables, `health-code-<version>.sha256` and the build provenance:

```sh
version=0.4.0
platform=linux-x64
base=https://github.com/doubleoevan/health-code/releases/download/v$version
curl --fail --location --remote-name "$base/health-code-$version-$platform" &&
  curl --fail --location --remote-name "$base/health-code-$version.sha256" &&
  sha256sum --check --ignore-missing "health-code-$version.sha256" &&
  gh attestation verify "health-code-$version-$platform" \
    --repo doubleoevan/health-code \
    --signer-workflow doubleoevan/health-code/.github/workflows/release.yml \
    --source-ref "refs/tags/v$version" \
    --deny-self-hosted-runners &&
  chmod +x "health-code-$version-$platform" &&
  mv "health-code-$version-$platform" /usr/local/bin/health-code
```

Each command runs only after the one before it succeeds, so a failed check installs nothing. The checksum proves the file is the one the release published. The attestation proves this repository's release workflow built it from that tag on a GitHub-hosted runner. Add `--source-digest` with the commit you reviewed to also require that commit. On macOS, check the checksum with `shasum -a 256 --check --ignore-missing "health-code-$version.sha256"`. Without the GitHub CLI, check the file against `health-code-<version>.sigstore.json` from the same release with `cosign verify-blob-attestation`.

Apple has not signed the executable. A file downloaded with `curl` or `gh` runs as is. macOS blocks one downloaded in a browser until you run `xattr -d com.apple.quarantine health-code-0.4.0-darwin-arm64`.

### npx

On another platform, or without the executable, run `npx health-code` with Node 22.18 or later on the 22.x line. Node 24.11 or later also works. npx installs the package's dependencies in the job when it runs.

## Setup

| Required | Value |
| --- | --- |
| `RUNTA_TOKEN` | Token from your [Runta account](https://dashboard.runta.com). It needs access to runtimes and secrets and the model-provider list. |
| `MODEL_API_KEY` | Model provider key. Only setup needs it. Setup stores it in Runta. |
| `HEALTH_CODE_MODEL_HOST` | Model provider address such as `https://api.anthropic.com`. Include the full API path when it isn't `/v1`, such as `https://api.z.ai/api/paas/v4` or `https://proxy.example.com/anthropic/v1`. Leave out `/chat/completions` or `/messages`. |
| `HEALTH_CODE_MODEL` | Model ID such as `claude-opus-5-5`. |


1. Set these variables on your own machine and run `health-code setup` or `npx health-code setup` once. Setup stores the model key in Runta and verifies it.
2. Remove `MODEL_API_KEY`. Add `RUNTA_TOKEN` to your CI secrets and set the model host and model ID in the job.

| Optional | Use |
| --- | --- |
| `HEALTH_CODE_SUMMARY_MODEL` | Model that summarizes release notes. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_MATCH_MODEL` | Model that matches new features to your code. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_REPAIR_MODEL` | Model that repairs checks an upgrade breaks. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_ADOPTION_MODEL` | Model that applies a new feature to your code. Defaults to `HEALTH_CODE_MODEL`. |
| `HEALTH_CODE_MODEL_PROTOCOL` | `anthropic` or `openai-compatible`. Defaults to `anthropic` for `https://api.anthropic.com` and `openai-compatible` for other hosts. Set `anthropic` for a proxy that uses the Anthropic API. |
| `HEALTH_CODE_INPUT_USD_PER_MILLION` | Highest price per million input tokens. Defaults to `10`. |
| `HEALTH_CODE_OUTPUT_USD_PER_MILLION` | Highest price per million output tokens. Defaults to `50`. |
| `GITHUB_TOKEN` | Reads the repository's manifests and release notes from GitHub at a higher rate limit. The command uses `GH_TOKEN` when this is unset. Without either, GitHub allows 60 requests an hour per address. Deciding what to test in a 15-workspace repository costs about 20 requests. |

The prices apply to every model you set and drive the spend limits. Set them when your model costs more than the defaults or to use more of each limit with a cheaper model. Run setup again after changing the host or protocol.


## Dependency pull requests

Add one workflow and the health inspector tries the upgrade behind a Renovate or Dependabot pull request on its own. It needs no bot setting: it answers any pull request from a branch of your repository that changes only package manifests, lockfiles and files the package manager generates, whoever opened it. It reads the pull request through GitHub's API and tests the same version in a sandbox. It opens its own pull request with the tested patch and comments on the original. It never checks out or runs the pull request's branch on your runner.

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

Change three things: the names of your CI workflows under `workflow_run`, the model settings and any setting below. Reference the workflow by the commit of a release tag, as with the install action. It answers pull requests in public repositories.

Before the first pull request:

1. Run `health-code setup` once, as [Setup](#setup) describes, and add `RUNTA_TOKEN` to the repository's Actions secrets.
2. If Dependabot opens your pull requests, also add `RUNTA_TOKEN` as a Dependabot secret with the same name, under Settings > Secrets and variables > Dependabot. A run that Dependabot starts reads Dependabot secrets.
3. Turn on **Allow GitHub Actions to create and approve pull requests** under Settings > Actions > General.
4. Create the `health-code` label.

Set the repository variable `HEALTH_CODE_DEPENDENCY_PULL_REQUESTS` to `off` to stop the workflow without an edit. The rest of the `if` line skips CI runs that did not fail, so a green run starts no job.

### What starts an inspection

| Path | Starts when | Tests |
| --- | --- | --- |
| Major | A pull request opens for a major upgrade of one package or one family, or a minor upgrade of a package below 1.0. It starts when the pull request opens, before your CI finishes. | The upgrade only |
| Red | One of the CI workflows you listed fails on any other dependency pull request for one package or one family, on a check that is green on the pull request's base commit. | The upgrade only |
| Asked | A person with write access adds the `health-code` label to a dependency pull request, red or green. | The upgrade and new features |
| By hand | You run [the form](#by-hand). | What you choose |

A pull request that holds several unrelated packages, no npm dependency or other code changes starts nothing. Neither does a pull request from a fork. The workflow run's summary says why. When a person adds the label to one, the pull request gets a comment with the reason. [`health-code target`](#read-a-pull-requests-upgrade) prints the same answer for any pull request.

The Red path compares each failed check with the same check on the base commit, so a failure your base branch already has starts nothing. Run your CI on pushes to the base branch too. Without a result on the base commit, the Red path starts nothing and the run summary says so.

The workflow inspects a dependency and version once per repository. A rebase or a second red CI starts nothing. Add the label to inspect it again. Its pull requests on `health-code/` branches never start it, and neither does their CI.

### What the pull request gets

The health inspector tests the upgrade at the pull request's base commit, the commit its branch started from. That branch is never changed.

- **A status.** `health-code` on the pull request's head: `pending` while the health inspector works, then `success` for Passes as is, Fixed or Fixed with test changes, `failure` for Can't fix and `error` when the upgrade was not tested.
- **A pull request.** The tested patch on `health-code/<dependency>-<version>`, beside the original, when the upgrade needed a repair. An upgrade that passes as is gets none, since it would repeat the original.
- **One comment** on the original pull request, replaced when the upgrade is inspected again:

```text
Health Code tried `react` 19.0.0 at `9c0d2e1` in a Runta sandbox.

- Verdict: Fixed
- Install: passed
- Typecheck: passed
- Tests: passed
- Tested patch: https://github.com/owner/repository/pull/124
- Cost: $1.42 model and $0.08 sandbox
- Inspection Report

The patch also moves `react-dom`, which this pull request does not.
```

The comment holds fixed text and values from the Inspection Report. It holds no release notes, no model text and no command output. The Inspection Report link opens the report the workflow run saved.

CI on Health Code's pull request waits for a person. GitHub holds the workflows of a pull request that the workflow's token opened until someone with write access selects **Approve workflows to run** on it. Review the patch first, since approval runs it on your runners. GitHub is still rolling this out. Where the pull request shows no approval banner and starts no CI, close and reopen it to start CI. Renovate closes its own pull request once the upgrade is on the base branch.

### Settings

Pass a setting under `with`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `model-host`, `model` | required | The model settings from [Setup](#setup). |
| `major` | `true` | The Major path. |
| `red` | `true` | The Red path. |
| `red-checks` | every check | The check names that count as red, separated by commas. |
| `label` | `health-code` | The label of the Asked path. |
| `feature-patches` | `false` | Also match new features to your code on the Major and Red paths. |
| `weekly-cap-usd` | `25` | The model and sandbox cost at which the week's inspections stop, on every path of this workflow. The week starts on Monday, UTC. |
| `at-cap` | `comment` | What a pull request gets at the cap. `comment` adds one comment and the `error` status. `status` sets the status only. |
| `timeout-minutes` | `75` | The job's time limit. The inspection stops itself 10 minutes earlier and deletes its sandboxes. An inspection has its own limit of 60 minutes. |
| `one-at-a-time` | `true` | Run one inspection at a time. The others wait in order. |
| `model-protocol`, `summary-model`, `match-model`, `repair-model`, `adoption-model`, `input-usd-per-million`, `output-usd-per-million` | unset | The optional model settings from [Setup](#setup). |

The cost of an inspection is known when it ends, so a week can pass the cap by one inspection. The week's total and the record of inspected versions live in Git references under `refs/health-code/` in your repository. Delete a reference to forget it.

### Permissions

The caller grants five permissions. GitHub stops the run at startup and names the permission when one is missing.

| Permission | Used for |
| --- | --- |
| `contents: write` | Push the `health-code/` branch and write the references under `refs/health-code/`. |
| `pull-requests: write` | Open Health Code's pull request, comment on the original and remove the label. |
| `statuses: write` | Set the `health-code` status. |
| `checks: read` | Read the checks of the pull request and of its base commit. |
| `attestations: read` | Verify the executable's build provenance. |

Two jobs run. The first reads the event and the pull request with a read-only token and no secret, and most events end there. Only the second holds `RUNTA_TOKEN` and the permissions above. Both install the executable of the commit you referenced, after the same checksum and provenance checks as the install action.

### Wait for the inspection before your CI installs

The sandbox tries a major before your runners install it only if your install jobs wait. Put the wait step before the install:

```yaml
- uses: doubleoevan/health-code/action/wait@<commit of the release> # v<release>
- run: npm ci
```

On a pull request that holds one major upgrade the step waits until the `health-code` status leaves `pending`, then the job continues. On any other pull request or event it returns at once. A job for a commit the pull request has already moved past gets no result, since the newer head has a job of its own. Jobs that install nothing need no wait.

| Input | Default | Meaning |
| --- | --- | --- |
| `timeout-minutes` | `75` | How long to wait for a result. |
| `require-inspection` | `false` | Fail the step when the status is `error` or no result arrives in time. By default the job continues with a warning. |

The job needs `contents: read`, `pull-requests: read`, `statuses: read` and `attestations: read`. The caller must also listen for `synchronize`, as above, so a rebased pull request gets its earlier result on the new head. With the Major path or the whole workflow turned off, remove the step or give it the same `if`.

## Weekly schedule

This GitHub Actions job tries the first eligible upgrade every Monday, opens a pull request and keeps the report:

```yaml
name: Try dependency upgrades
on:
  schedule:
    - cron: "0 6 * * 1"
  workflow_dispatch:
permissions:
  contents: write
  pull-requests: write
  attestations: read
jobs:
  health-code:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: doubleoevan/health-code@<commit of v0.4.0> # v0.4.0
      - run: health-code check https://github.com/${{ github.repository }} --pull-request
        env:
          RUNTA_TOKEN: ${{ secrets.RUNTA_TOKEN }}
          HEALTH_CODE_MODEL_HOST: https://api.anthropic.com
          HEALTH_CODE_MODEL: claude-opus-5-5
          GH_TOKEN: ${{ github.token }}
      - uses: actions/upload-artifact@v4
        with:
          name: health-code-report
          path: health-code-report
```

## By hand

This form tests the upgrade behind any Renovate or Dependabot pull request. It stays outside the weekly cap. Start it with the package, the version the tool chose and the pull request's base commit. It tests that version at that commit, repairs what breaks and opens a pull request with the upgrade patch only:

```yaml
name: Test a failing upgrade
on:
  workflow_dispatch:
    inputs:
      dependency:
        description: Package name
        required: true
      version:
        description: Version the pull request selects
        required: true
      base:
        description: Base commit of the pull request
        required: true
permissions:
  contents: write
  pull-requests: write
  attestations: read
jobs:
  health-code:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          fetch-depth: 0
      - uses: doubleoevan/health-code@<commit of v0.4.0> # v0.4.0
      - run: health-code check https://github.com/${{ github.repository }} --dependency "$DEPENDENCY" --to "$VERSION" --revision "$BASE" --upgrade-only --pull-request
        env:
          DEPENDENCY: ${{ inputs.dependency }}
          VERSION: ${{ inputs.version }}
          BASE: ${{ inputs.base }}
          RUNTA_TOKEN: ${{ secrets.RUNTA_TOKEN }}
          HEALTH_CODE_MODEL_HOST: https://api.anthropic.com
          HEALTH_CODE_MODEL: claude-opus-5-5
          GH_TOKEN: ${{ github.token }}
```

## The check command

```sh
health-code check https://github.com/owner/repository --dependency zod --to 4.0.0
```

With npx, run `npx health-code check` with the same arguments.

`--dependency` and `--to` accept any version that meets five conditions:

- The npm registry lists it.
- It is not deprecated.
- It is not a prerelease.
- It is above the highest version any workspace has installed.
- It passes the repository's minimum release age.

Patch releases qualify, so the command can test the exact version another tool chose. A version that fails a condition stops the command before any sandbox starts. The message gives the reason and the versions the command accepts:

```text
zod 4.0.3 is deprecated. Eligible versions: 4.0.5, 4.0.4 and 4.0.2. (invalid-upgrade)
```

Omit the target to test the first eligible upgrade. The command then builds the upgrade menu, the newest minor and the newest major version of each direct dependency, and saves it as `upgrade-menu.json`.

The command writes `inspection-report.json` and any `.patch` files to `health-code-report/`. Use `--output` to change the folder and `--revision` to inspect one commit.

`health-code --version` prints the release, such as `health-code 0.4.0`. `health-code --version --json` also prints the runtime and the SHA-256 digest of each file the command reads from its own package: `package.json`, the prompt templates and the code it uploads to the sandbox. The executable and the npm package of one version print the same digests. Either form exits 1 and names the file when one is missing or damaged.

| Result | Exit code |
| --- | --- |
| The upgrade was tested. Read its verdict in the report. An upgrade without a patch also exits zero. | 0 |
| Nothing is eligible. The command starts no sandbox and removes the folder's earlier report and patches. | 0 |
| The named version is not eligible, or the menu could not tell whether anything is eligible. | 1 |
| The inspection failed or stopped early. | 1 |

### Read a pull request's upgrade

```sh
health-code target https://github.com/owner/repository/pull/123
```

`target` reads the single upgrade a dependency pull request holds, such as one from Renovate or Dependabot. It needs no Runta account and no model, makes no checkout and executes nothing from the pull request. It compares the manifests and the lockfile at the pull request's base commit and at its head through GitHub's API and prints one JSON object:

```json
{
  "pullRequest": 123,
  "author": "renovate[bot]",
  "headCommit": "5b1f…",
  "baseCommit": "9c0d…",
  "upgrade": { "dependency": "react", "from": "18.3.1", "to": "19.0.0", "kind": "major" },
  "isMajor": true,
  "movedWith": [{ "dependency": "react-dom", "from": "18.3.1", "to": "19.0.0" }]
}
```

The base commit is the commit the pull request's branch started from. `isMajor` is true for a major upgrade and for a minor upgrade of a package below 1.0. Several packages count as one family when they share an npm scope or all move to the same version. One is the target and the rest are `movedWith`. Pass `upgrade.dependency`, `upgrade.to` and `baseCommit` to `health-code check` as `--dependency`, `--to` and `--revision`.

A pull request with no single upgrade prints a reason and still exits 0:

| Reason | The pull request |
| --- | --- |
| `other-changes` | Also changes files other than manifests, lockfiles and files the package manager generates, such as Yarn's `.yarn/cache/`. |
| `fork` | Comes from a fork. A branch name never counts. |
| `own-pull-request` | Comes from a `health-code/` branch. |
| `no-npm-dependency` | Changes no manifest and no lockfile. |
| `no-direct-dependency` | Moves only packages no manifest declares. |
| `grouped` | Moves several unrelated packages. |
| `mixed-versions` | Leaves a package on different versions across workspaces. |
| `not-an-upgrade` | Adds, removes or lowers a dependency. |
| `unreadable` | Has package files GitHub's API cannot serve, such as a binary `bun.lockb`. |

The command exits 1 when GitHub cannot be read, for example when its request limit is used up. Set `GITHUB_TOKEN` or `GH_TOKEN` to raise the limit.

A cancelled job deletes its sandboxes before it exits. If CI kills the job first, delete any sandbox named `health-code-…` in the Runta dashboard.

The command lists or checks a project in the sandbox when it cannot read it from GitHub. The log says why. This covers four cases:

- A binary `bun.lockb`.
- A manifest or lockfile that is a symbolic link.
- A repository too large for GitHub to list in one request.
- A project past an upgrade menu limit: more than 200 workspace manifests, a lockfile over 16 MiB or more than 32 MiB of files to read.

The sandbox installs the package manager version your repository declares in `packageManager`, `devEngines.packageManager`, `engines` or `.bun-version`. The version your frozen install uses then writes the patch's lockfile. It falls back to its bundled version when nothing is declared or the declared version cannot be verified. The report's `packageManager` and the pull request say which version wrote the lockfile.

Add `--upgrade-only` to spend only on the repair. The command still summarizes the release notes, because the repair reads the summary. It skips matching new features to your code and applying one, and returns at most the upgrade patch.

Tests receive placeholder environment values. Supply a non-secret value with `--env NAME=value`, repeated as needed. The sandbox and its saved output can expose these values.

Add `--pull-request` to open a pull request with the tested patches. Run it from a full checkout of the repository with `git` and `gh` available and `GH_TOKEN` set. The command applies the patches on a `health-code/<dependency>-<version>` branch at the inspected commit, pushes it and opens the pull request with the verdict and check results. Running the same upgrade again replaces that branch and updates its open pull request. Commits pushed to that branch by hand are lost, so merge or move them first. The checkout's Git hooks stay off for these steps and the checkout returns to its starting commit afterward.

GitHub blocks this by default. Turn on **Allow GitHub Actions to create and approve pull requests** in the repository under Settings > Actions > General. GitHub holds the CI of a pull request that `github.token` opened until someone with write access selects **Approve workflows to run** on it. A personal access token in `GH_TOKEN` lets the push start your other workflows on the patched code before anyone reviews it.

## Unpublished checkout

Build the library with `bun run --cwd packages/health-code build`, then run `bun run --cwd apps/cli build`. Use `node packages/health-code/dist/cli/cli.js` in place of `npx health-code`. `bun run test:executable` also builds the standalone executable for your machine at `apps/cli/build/health-code-<version>-<platform>`.

MIT licensed.
