# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
