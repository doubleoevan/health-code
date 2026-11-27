# Health Code in CI

[npm](https://www.npmjs.com/package/health-code) · [GitHub](https://github.com/doubleoevan/health-code) · [Demo](https://runhealthcode.dev)

Try a dependency upgrade on a public GitHub repository from a CI job. On the CI machine, the command reads GitHub and the npm registry to decide what to test. The upgraded code then runs in one Runta sandbox on your own Runta account. Your pipeline receives an Inspection Report and a pull request with the tested patch.

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


## Run in CI

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

GitHub blocks this by default. Turn on **Allow GitHub Actions to create and approve pull requests** in the repository under Settings > Actions > General. With `github.token` the pushed branch starts no other workflow. A personal access token in `GH_TOKEN` lets the push start your other workflows on the patched code before anyone reviews it.

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

This job tests the upgrade behind a failing Renovate or Dependabot pull request. Start it with the package, the version the tool chose and the pull request's base commit. It tests that version at that commit, repairs what breaks and opens a pull request with the upgrade patch only:

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

## Unpublished checkout

Build the library with `bun run --cwd packages/health-code build`, then run `bun run --cwd apps/cli build`. Use `node packages/health-code/dist/cli/cli.js` in place of `npx health-code`. `bun run test:executable` also builds the standalone executable for your machine at `apps/cli/build/health-code-<version>-<platform>`.

MIT licensed.
