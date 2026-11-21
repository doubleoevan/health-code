# package-releases Specification

## Purpose
Let reviewers install the public library or MCP command and verify the source and workflow that produced each published npm artifact.

## Requirements

### Requirement: Publish matching packages with provenance

A version tag SHALL stage matching versions of health-code and @health-code/mcp through npm trusted publishing from GitHub Actions with provenance and separate README files. Each package SHALL trust its release workflow through stage-only OIDC with no GitHub environment. The maintainer SHALL approve each staged version on npmjs.com before it becomes public. Publication SHALL use no stored npm token. The unscoped library entry and existing MCP invocation SHALL remain compatible.

#### Scenario: Workflow identity

- **WHEN** the tag workflow stages with provenance without `NPM_TOKEN`
- **THEN** npm verifies the configured workflow identity for each package and both versions await maintainer approval. Approved artifacts have verifiable provenance. A trust mismatch stops publication

#### Scenario: Clean install

- **WHEN** a reviewer installs the released library or invokes either documented MCP entry from a clean supported Node environment
- **THEN** the library imports and both CLI forms reach the same MCP implementation, with registry provenance verifiable for both packages

#### Scenario: Resume a partially published tag

- **WHEN** the library is already published for the tag and the scoped package is missing
- **THEN** the workflow verifies the existing version, digest and provenance before publishing the missing package, and stops on a mismatch

### Requirement: Give reviewers a runnable introduction

The root README SHALL describe the product in two lines, name the hosted URL, show site and MCP quick starts, offline replay, architecture, Runta controls, real and mocked behavior, tests and license.

#### Scenario: Reviewer without credentials

- **WHEN** a reviewer follows the replay instructions in a clean checkout
- **THEN** the local interactive report opens without contacting Runta or a model
