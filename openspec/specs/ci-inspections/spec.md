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

The `health-code check` command SHALL test one eligible upgrade with the caller's account, write the Inspection Report and each verified mailbox to the output folder and print step progress. A partial report or a failed inspection SHALL exit nonzero.

#### Scenario: A pipeline tests a chosen version

- **WHEN** the caller names a dependency and version
- **THEN** the command confirms it is eligible, pins the commit that lists it and tests that version there.

#### Scenario: A pipeline is cancelled

- **WHEN** the process receives SIGTERM or SIGINT
- **THEN** the inspection stops and deletes its sandboxes before the process exits.

### Requirement: Open a pull request

With `--pull-request` the command SHALL apply each upgrade’s tested patches on its own branch of the current checkout at the inspected commit, push the branch and open or update one pull request through the caller’s `git` and `gh`. The pull request SHALL state the Verdict and check results, link to Health Code, Runta and the CI setup and include no repository, release or command text. The command SHALL hold no GitHub credential of its own.

#### Scenario: A tested patch exists

- **WHEN** the inspection returns a patch and the caller passed `--pull-request`
- **THEN** the command applies the upgrade patch before any feature patch, pushes the branch named for the dependency and version and opens the pull request

#### Scenario: The same upgrade runs again

- **WHEN** a branch for that dependency and version already exists
- **THEN** the command replaces it with the newly tested patches

#### Scenario: Its pull request is still open

- **WHEN** the same repository already has an open pull request from that branch
- **THEN** the command updates its title and results and opens no second one. A fork’s pull request from a branch with the same name stays unchanged.

#### Scenario: No patch

- **WHEN** the upgrade has no tested patch
- **THEN** the command opens no pull request and still writes the report

#### Scenario: Git or the GitHub CLI fails

- **WHEN** a `git` or `gh` step fails
- **THEN** the command exits unsuccessfully and names the failed step and what the checkout or repository setting needs

### Requirement: Explain failures

Every failed command SHALL print its cause and a next step. An inspection error SHALL include its code for bug reports. Unexpected errors SHALL expose no internal text.

#### Scenario: Account problem

- **WHEN** Runta rejects the token or its permissions
- **THEN** the message names the token or the missing access and where to fix it

#### Scenario: Temporary problem

- **WHEN** an inspection times out or Runta is unavailable
- **THEN** the message says to try again and what to change if it repeats
