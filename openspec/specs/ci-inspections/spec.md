# ci-inspections Specification

## Purpose
Give a pipeline one command that tries a dependency upgrade on a public Repository with the caller’s account and returns the Inspection Report and tested Patches.

## Requirements

### Requirement: Connect an account once

The command `npx health-code setup` SHALL check account access, register or reuse the origin-bound stored secret, verify it with one bounded authenticated model request sandbox request, and confirm cleanup before naming the settings a CI job needs. Its output SHALL contain no credential.

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
