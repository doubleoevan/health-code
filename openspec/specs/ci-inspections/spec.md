# ci-inspections Specification

## Purpose
Give a pipeline one command that tries a dependency upgrade on a public Repository with the caller’s account and returns the Inspection Report and tested Patches.

## Requirements

### Requirement: Connect an account once

The command `health-code setup`, run through npx or the standalone executable, SHALL check account access, register or reuse the origin-bound stored secret, verify it with one bounded authenticated model request sandbox request, and confirm cleanup before naming the settings a CI job needs. Its output SHALL contain no credential.

#### Scenario: First setup and key rotation

- **WHEN** the user supplies a model key to setup for the selected HTTPS origin
- **THEN** it stores or rotates the same named secret, tests it through an ephemeral model request sandbox with a fixed one-output-token request, and deletes the model request sandbox. It makes no Repository checkout or Inspection and prints no key.

#### Scenario: Setup fails

- **WHEN** account access, registration, secret lookup, model request sandbox authentication or cleanup fails
- **THEN** setup exits unsuccessfully with a corrective action and any needed cleanup identifier. It prints no success message, request headers, model key, token value or upstream response body.

#### Scenario: Existing registration

- **WHEN** setup has the sandbox token and model settings without a key and that origin already has the expected secret
- **THEN** it verifies the stored key through the model request sandbox without downloading, replacing or requesting the key again. A missing secret produces registration instructions for that origin.

### Requirement: Route personally funded inspections

The caller SHALL fund sandbox, model request sandbox and model use. The caller SHALL configure the model host and a model ID, with optional price bounds and an optional model ID per role. Unset price bounds SHALL default to $10 per million input tokens and $50 per million output tokens. The command SHALL name every missing setting and the setup command in one error and choose no model itself. It SHALL support Anthropic and OpenAI-compatible hosts. A model host SHALL accept an API path and use `/v1` when it has none. The command SHALL select model request sandbox execution for summaries and Code Feature Matches and use the existing sandbox binding for Repair and Feature adoption. A live Inspection SHALL require `RUNTA_TOKEN` and the model settings, with the key stored in Runta. An optional GitHub credential SHALL serve release retrieval only.

#### Scenario: First Inspection after setup

- **WHEN** the job supplies the sandbox token and model settings after a successful setup
- **THEN** it can complete an Inspection, including summaries and Code Feature Matches from the Model Request Sandbox and eligible Agent Attempts. No local authenticated model client is constructed. Logs and saved evidence contain no raw key.

#### Scenario: Host mismatch

- **WHEN** a role selects an origin without its registered secret
- **THEN** the command reports that setup is required for that origin. It never sends another origin’s credential, falls back to a local key or dispatches a request through an unverified binding.

#### Scenario: Model host with a path

- **WHEN** the model host includes an API path
- **THEN** every model request uses that path and the stored key stays named for the origin

### Requirement: Check one upgrade in CI

The `health-code check` command SHALL decide what to test on the CI machine before it allocates a sandbox, test one upgrade with the caller's account, write the Inspection Report and each verified mailbox to the output folder and print step progress. With no named version it SHALL build the Upgrade menu and write it to the output folder. It SHALL read the GitHub token from `GITHUB_TOKEN` and otherwise from `GH_TOKEN`. A partial report, a failed inspection or a menu whose eligibility is unknown SHALL exit nonzero.

#### Scenario: A pipeline tests a chosen version

- **WHEN** the caller names a dependency and any stable published version above the installed one that passes the Minimum release age and advances every declaring workspace, a patch release included
- **THEN** the command keeps the commit it read and tests that version there in one repository sandbox.

#### Scenario: A pipeline is cancelled

- **WHEN** the process receives SIGTERM or SIGINT
- **THEN** the inspection stops and deletes its sandboxes before the process exits.

#### Scenario: A named version is not eligible

- **WHEN** the caller names a version that is unpublished, deprecated, a prerelease, not newer or too new
- **THEN** the command allocates no sandbox, states the reason, names the versions it accepts and exits nonzero.

#### Scenario: A version another tool chose

- **WHEN** a job passes the patch release a Renovate pull request selected and the pull request's base commit
- **THEN** the command tests that version at that commit although the Upgrade menu would list a newer one.

#### Scenario: No target is named

- **WHEN** the caller names no dependency
- **THEN** the command tests the menu's first eligible target in one repository sandbox.

#### Scenario: Nothing to upgrade

- **WHEN** the menu is complete and lists no eligible upgrade
- **THEN** the command allocates no sandbox, writes the menu, removes the output folder's previous report and patches, says no upgrade is eligible at the commit and exits zero.

#### Scenario: Eligibility unknown

- **WHEN** the menu lists no eligible upgrade and reports an issue
- **THEN** the command prints the issue, allocates no sandbox and exits nonzero.

#### Scenario: A repository the menu cannot read

- **WHEN** the menu returns an unreadable reason
- **THEN** the command prints the reason and lists the upgrades in a sandbox with the caller's account. With a named version it tests in one sandbox, which validates the version.

### Requirement: Open a pull request

With `--pull-request` the command SHALL apply each upgrade’s tested patches on its own branch of the current checkout at the inspected commit, push the branch and open or update one pull request through the caller’s `git` and `gh`. The pull request SHALL state the Verdict, the check results and the package manager version that wrote the lockfile, link to Health Code, Runta and the CI setup and include no repository, release or command text. The command SHALL hold no GitHub credential of its own. Its `git` steps SHALL run with the checkout’s hooks off and a time limit, and SHALL return the checkout to the commit it started on.

#### Scenario: A tested patch exists

- **WHEN** the inspection returns a patch and the caller passed `--pull-request`
- **THEN** the command applies the upgrade patch before any feature patch, pushes the branch named for the dependency and version and opens the pull request

#### Scenario: The same upgrade runs again

- **WHEN** a branch for that dependency and version already exists
- **THEN** the command replaces it with the newly tested patches

#### Scenario: Its pull request is still open

- **WHEN** the same repository already has an open pull request from that branch
- **THEN** the command updates its title and results and opens no second one. A fork’s pull request from a branch with the same name stays unchanged.

#### Scenario: The checkout has Git hooks

- **WHEN** the checkout has hooks installed
- **THEN** no hook runs while the command switches branches, applies patches or pushes

#### Scenario: A patch fails to apply

- **WHEN** `git` rejects a patch
- **THEN** the command clears the unfinished patch, returns the checkout to its starting commit and reports the failure

#### Scenario: No patch

- **WHEN** the upgrade has no tested patch
- **THEN** the command opens no pull request and still writes the report

#### Scenario: Git or the GitHub CLI fails

- **WHEN** a `git` or `gh` step fails
- **THEN** the command exits unsuccessfully and names the failed step and what the checkout or repository setting needs

#### Scenario: The Repository declares its package manager

- **WHEN** the Repository declares Bun 1.4.4 and the sandbox installed it
- **THEN** the pull request says Bun 1.4.4 wrote the lockfile and that the Repository declares it

#### Scenario: The bundled version wrote the lockfile

- **WHEN** the declared version could not be installed
- **THEN** the pull request names the bundled version that wrote the lockfile and the reason

### Requirement: Explain failures

Every failed command SHALL print its cause and a next step. An inspection error SHALL include its code for bug reports. Unexpected errors SHALL expose no internal text.

#### Scenario: Account problem

- **WHEN** Runta rejects the token or its permissions
- **THEN** the message names the token or the missing access and where to fix it

#### Scenario: Temporary problem

- **WHEN** an inspection times out or Runta is unavailable
- **THEN** the message says to try again and what to change if it repeats

#### Scenario: GitHub limit

- **WHEN** GitHub's request limit is used up while the menu is built
- **THEN** the message names the reset time and says to set `GITHUB_TOKEN` when none was supplied

#### Scenario: Repository or revision not found

- **WHEN** GitHub cannot find a public Repository at the URL or the commit at `--revision`
- **THEN** the message says which one was not found and what to check

### Requirement: Test the upgrade only

With `--upgrade-only` the command SHALL request no Code Feature Match and run no Feature adoption. It SHALL still run the release summary and the repair, and SHALL return at most the upgrade Patch.

#### Scenario: A red pull request

- **WHEN** a job passes `--upgrade-only` for an upgrade whose tests fail
- **THEN** the repair runs, the output holds the Inspection Report and the upgrade Patch, and no model request is made for a Code Feature Match or Feature adoption

#### Scenario: The upgrade passes as is

- **WHEN** a job passes `--upgrade-only` and the upgrade's checks pass
- **THEN** the report records the Verdict and no Agent Attempt runs

#### Scenario: With a pull request

- **WHEN** a job passes `--upgrade-only` and `--pull-request`
- **THEN** the pull request carries the upgrade Patch and no feature Patch

### Requirement: Run the command from the standalone executable

The standalone executable SHALL run `health-code check` and `health-code setup` with no Node and no package install on the machine. It SHALL accept the same arguments and settings as the npm command and print the same output, exit with the same codes and write the same report files. It SHALL need `git` and `gh` only for `--pull-request`.

#### Scenario: A pipeline without Node

- **WHEN** a job on a supported platform with no Node runs the downloaded executable with the CI settings
- **THEN** it tests one upgrade and writes the Inspection Report and patches as the npm command does

#### Scenario: Same failure on both builds

- **WHEN** a setting is missing or an argument is invalid
- **THEN** the executable and the npm command print the same message and exit with the same code

#### Scenario: Same Verdict on both builds

- **WHEN** both builds inspect the same Repository commit and Upgrade with the same models
- **THEN** both reports carry the same Verdict

#### Scenario: Cancelled executable

- **WHEN** the executable receives SIGTERM or SIGINT during an inspection
- **THEN** it stops the inspection and deletes its sandboxes before it exits

#### Scenario: Pull request from the executable

- **WHEN** the executable runs with `--pull-request` in a checkout with `git` and `gh` available
- **THEN** it opens or updates the pull request as the npm command does, with the checkout's hooks off

### Requirement: Keep repository configuration out of the executable

The standalone executable SHALL NOT load a `.env`, `bunfig.toml`, `tsconfig.json` or `package.json` from its working directory or any parent folder.

#### Scenario: A checkout with runtime configuration

- **WHEN** the executable runs in a checkout whose `bunfig.toml` names a preload script and whose `.env` sets a Health Code setting
- **THEN** the preload script does not run and the setting is not read

### Requirement: Print the version

`health-code --version` SHALL print the release version and exit zero on both builds. `health-code --version --json` SHALL also print the runtime and the SHA-256 digest of every file the command reads from its own package, so a reviewer can compare two builds.

#### Scenario: Plain version

- **WHEN** a user runs `health-code --version`
- **THEN** the command prints `health-code <version>` and exits zero without reading settings or contacting any service

#### Scenario: Compare the builds

- **WHEN** a reviewer runs `health-code --version --json` from the executable and from the npm package of the same version
- **THEN** both list the same files with the same digests

#### Scenario: A package file is missing or damaged

- **WHEN** a file the command reads from its own package is missing or a prompt template is invalid
- **THEN** `--version` names the file and exits nonzero

### Requirement: Install the executable in GitHub Actions

The repository SHALL provide a GitHub Action that installs the standalone executable for the runner's platform. By default it installs the release version of the action's own commit. It SHALL verify the checksum and the build provenance before it puts `health-code` on `PATH`. It SHALL need no secret beyond a read-only GitHub token.

#### Scenario: Install the action's version

- **WHEN** a workflow uses the action at a release commit on Linux x64, Linux arm64 or macOS arm64
- **THEN** `health-code --version` in a later step prints that release's version

#### Scenario: Tampered download

- **WHEN** the downloaded executable does not match the release checksum or its provenance does not name the release workflow and tag
- **THEN** the action fails and puts nothing on `PATH`

#### Scenario: Unsupported runner

- **WHEN** the runner is Windows, macOS x64 or another platform without an executable
- **THEN** the action fails and names the supported platforms and the npx command

### Requirement: Read the upgrade a pull request holds

`health-code target <pull-request-url>` SHALL read the manifests and the lockfile at the pull request's base commit and at its head through GitHub's API and print one JSON object. The object SHALL name the dependency, the version the head installs, the base commit, whether the upgrade counts as a major and the packages that moved with it, or one reason from a fixed list. The command SHALL exit zero for a target and for a reason and nonzero when GitHub cannot be read.

#### Scenario: One package

- **WHEN** a Renovate pull request moves `left-pad` from 1.2.0 to 1.3.0 in a pnpm repository
- **THEN** the output names `left-pad`, 1.3.0, 1.2.0 and the base commit, with `isMajor` false and no moved packages

#### Scenario: Each package manager

- **WHEN** the same single upgrade is read from an npm, a pnpm, a Yarn and a Bun repository
- **THEN** each output names the same dependency and versions

#### Scenario: One package in several workspaces

- **WHEN** three workspaces declare the package and the head moves all three to one version
- **THEN** the output names one target at that version

#### Scenario: Workspaces end on different versions

- **WHEN** the head leaves the package on different versions across workspaces
- **THEN** the output gives the reason `mixed-versions`

#### Scenario: A lockfile-only change

- **WHEN** no manifest changed and the lockfile moves one direct dependency
- **THEN** the output names that dependency and the version the head locks

#### Scenario: Only transitive packages moved

- **WHEN** the lockfile changed and no direct dependency's locked version did
- **THEN** the output gives the reason `no-direct-dependency`

#### Scenario: An action or image bump

- **WHEN** the pull request changes no manifest and no lockfile
- **THEN** the output gives the reason `no-npm-dependency`

#### Scenario: A downgrade or a removal

- **WHEN** the head locks a lower version or drops the dependency
- **THEN** the output gives the reason `not-an-upgrade`

#### Scenario: GitHub is unavailable

- **WHEN** GitHub's request limit is used up or the pull request does not exist
- **THEN** the command prints the cause and a next step and exits nonzero

### Requirement: Name a major and a Package family

The target command SHALL count a major upgrade, and a minor upgrade from a version below 1.0, as a major. It SHALL treat several moved packages as one Package family when they share one npm scope or all move to the same version, name one of them as the target and list the others as moved with it. Any other set of several packages SHALL give the reason `grouped`.

#### Scenario: A major

- **WHEN** the head moves a package from 18.3.1 to 19.0.0
- **THEN** `isMajor` is true

#### Scenario: A minor below 1.0

- **WHEN** the head moves a package from 0.4.2 to 0.5.0
- **THEN** `isMajor` is true

#### Scenario: A patch below 1.0

- **WHEN** the head moves a package from 0.4.2 to 0.4.3
- **THEN** `isMajor` is false

#### Scenario: A family

- **WHEN** the head moves `react` and `react-dom` to 19.0.0
- **THEN** the output names `react` as the target and lists `react-dom` as moved with it

#### Scenario: A grouped pull request

- **WHEN** the head moves six packages with different scopes and versions
- **THEN** the output gives the reason `grouped` and the number of packages

### Requirement: Recognize a dependency pull request by its content

The target command SHALL answer a pull request whose head branch is in the base repository and whose changed files are only package manifests, lockfiles and the package manager's own files. It SHALL NOT read the author, the branch name or the title to decide. A pull request from a branch Health Code pushed SHALL give the reason `own-pull-request`.

#### Scenario: Renovate, Dependabot and a person

- **WHEN** Renovate, Dependabot or a person opens a pull request from a branch of the repository that changes only `package.json` and the lockfile
- **THEN** the command reads the target for each and prints the author's login

#### Scenario: A fork's branch named like a bot's

- **WHEN** a fork's pull request comes from a branch named `renovate/react-19.x`
- **THEN** the output gives the reason `fork`

#### Scenario: Other files changed

- **WHEN** the pull request moves one dependency and also changes a source file
- **THEN** the output gives the reason `other-changes`

#### Scenario: Yarn's own files

- **WHEN** the pull request changes `package.json`, `yarn.lock` and files under `.yarn/`
- **THEN** the command reads the target

#### Scenario: More changed files than GitHub lists

- **WHEN** the comparison lists 300 changed files
- **THEN** the output gives the reason `other-changes`

### Requirement: Read a pull request without executing it

The target command SHALL make no checkout, allocate no sandbox and execute nothing from the pull request. It SHALL send requests to GitHub's API origin only, within the byte and request bounds of the Upgrade menu, and treat every file, name and version as untrusted. It SHALL print a package name or a version only when it passes npm's grammar. A Repository the API cannot serve SHALL give the reason `unreadable`.

#### Scenario: An oversized or binary lockfile

- **WHEN** the head's lockfile is binary or past the byte limit
- **THEN** the output gives the reason `unreadable` and the command reads no further

#### Scenario: A crafted name

- **WHEN** a manifest at the head declares a dependency whose name fails npm's grammar
- **THEN** the name appears nowhere in the output

#### Scenario: No model and no account

- **WHEN** the command runs without `RUNTA_TOKEN` and without model settings
- **THEN** it reads the target, since it needs neither
