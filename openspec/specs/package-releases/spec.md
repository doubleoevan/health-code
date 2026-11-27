# package-releases Specification

## Purpose
Let reviewers install the public library and its CI command and verify the source and workflow that produced the published npm artifact.

## Requirements

### Requirement: Publish the package with provenance

A version tag SHALL stage health-code through npm trusted publishing from GitHub Actions with provenance and its README. The package SHALL trust its release workflow through stage-only OIDC with no GitHub environment. The maintainer SHALL approve the staged version on npmjs.com before it becomes public. While npm rejects the workflow identity, staging MAY use an npm token that only the staging command receives. Otherwise publication SHALL use no stored npm token. The library entry and the `health-code` command SHALL remain compatible.

#### Scenario: Workflow identity

- **WHEN** the tag workflow stages with provenance without `NPM_TOKEN`
- **THEN** npm verifies the configured workflow identity and the version awaits maintainer approval. Approved artifacts have verifiable provenance. A trust mismatch stops publication

#### Scenario: Repository token

- **WHEN** the tag workflow stages with `NPM_TOKEN` set
- **THEN** builds and tests run without the token and the version still awaits maintainer approval with provenance

#### Scenario: Clean install

- **WHEN** a reviewer installs the released library or invokes its command from a clean supported Node environment
- **THEN** the library imports and the command prints its usage, with registry provenance verifiable for the package

#### Scenario: Run against a published tag

- **WHEN** the library is already published for the tag
- **THEN** the workflow verifies the existing version, digest and provenance and stops on a mismatch

### Requirement: Give reviewers a runnable introduction

The root README SHALL describe the product in a few lines, name the hosted URL and show site and CI quick starts, packages, architecture and license. The guides it links SHALL cover every CI setting, offline replay, Runta controls and tests. The README's architecture diagram and the guides SHALL state that testing an Upgrade needs a Runta account and that the Upgrade menu does not.

#### Scenario: Reviewer without credentials

- **WHEN** a reviewer follows the replay instructions in a clean checkout
- **THEN** the local interactive report opens without contacting Runta or a model

#### Scenario: Reviewer without a Runta account

- **WHEN** a reviewer follows the library quick start with no Runta account
- **THEN** the documented call returns an Upgrade menu for a public Repository, and the docs name the account as the requirement for the next step

### Requirement: Publish the standalone executables

A version tag SHALL build the standalone executable for Linux x64, Linux arm64 and macOS arm64 from the frozen lockfile and the tagged commit. Each build SHALL run its own tests on its own platform before release. The GitHub release for the tag SHALL carry each executable, named with the version and platform, a SHA-256 checksum file and a signed build provenance attestation that names the release workflow, the tag and the commit.

#### Scenario: Verify a downloaded executable

- **WHEN** a user downloads an executable and the checksum file from the release and runs the documented checksum and provenance commands
- **THEN** both pass and the provenance names `.github/workflows/release.yml`, the tag and its commit

#### Scenario: A file changed after release

- **WHEN** a release executable differs from the attested bytes
- **THEN** the checksum and provenance commands fail

### Requirement: Keep the executables and the npm package in step

The executables and the npm package of one version SHALL carry identical package files: `package.json`, the prompt templates and the Guest bundles. The npm package SHALL be staged only after every executable built, passed its tests and was published.

#### Scenario: Identical package files

- **WHEN** the release builds the executables and packs the npm tarball
- **THEN** the release compares the file digests each executable reports with the tarball's and stops before staging on any difference

#### Scenario: An executable build fails

- **WHEN** any platform's executable fails to build or fails its tests
- **THEN** the release publishes no executable and stages no npm package for that version

### Requirement: Limit release write access

Only the job that uploads release files SHALL hold `contents: write`. The jobs that build and test the executables SHALL hold read access only and receive no npm token.

#### Scenario: Review the workflow permissions

- **WHEN** a reviewer reads the release workflow
- **THEN** exactly one job grants `contents: write`, and it runs no repository build or test command
