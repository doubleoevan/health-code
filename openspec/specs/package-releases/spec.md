# package-releases Specification

## Purpose
Let reviewers install the public library and its CI command and verify the source and workflow that produced the published npm artifact.

## Requirements

### Requirement: Publish the package with provenance

A version tag SHALL stage health-code through npm trusted publishing from GitHub Actions with provenance and its README. The package SHALL trust its release workflow through stage-only OIDC with no GitHub environment. The maintainer SHALL approve the staged version on npmjs.com before it becomes public. While npm rejects the workflow identity, staging MAY use a short-lived npm token that only the staging command receives. The maintainer SHALL delete it after approval. Otherwise publication SHALL use no stored npm token. The library entry and the `health-code` command SHALL remain compatible.

#### Scenario: Workflow identity

- **WHEN** the tag workflow stages with provenance without `NPM_TOKEN`
- **THEN** npm verifies the configured workflow identity and the version awaits maintainer approval. Approved artifacts have verifiable provenance. A trust mismatch stops publication

#### Scenario: Temporary token

- **WHEN** the tag workflow stages with `NPM_TOKEN` set
- **THEN** builds and tests run without the token and the version still awaits maintainer approval with provenance

#### Scenario: Clean install

- **WHEN** a reviewer installs the released library or invokes its command from a clean supported Node environment
- **THEN** the library imports and the command prints its usage, with registry provenance verifiable for the package

#### Scenario: Run against a published tag

- **WHEN** the library is already published for the tag
- **THEN** the workflow verifies the existing version, digest and provenance and stops on a mismatch

### Requirement: Give reviewers a runnable introduction

The root README SHALL describe the product in a few lines, name the hosted URL and show site and CI quick starts, packages, architecture and license. The guides it links SHALL cover every CI setting, offline replay, Runta controls and tests.

#### Scenario: Reviewer without credentials

- **WHEN** a reviewer follows the replay instructions in a clean checkout
- **THEN** the local interactive report opens without contacting Runta or a model
