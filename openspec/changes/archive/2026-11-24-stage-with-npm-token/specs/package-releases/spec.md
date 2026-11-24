## MODIFIED Requirements

### Requirement: Publish matching packages with provenance

A version tag SHALL stage matching versions of health-code and @health-code/mcp through npm trusted publishing from GitHub Actions with provenance and separate README files. Each package SHALL trust its release workflow through stage-only OIDC with no GitHub environment. The maintainer SHALL approve each staged version on npmjs.com before it becomes public. While npm rejects the workflow identity, staging MAY use a short-lived npm token that only the staging command receives. The maintainer SHALL delete it after approval. Otherwise publication SHALL use no stored npm token. The unscoped library entry and existing MCP invocation SHALL remain compatible.

#### Scenario: Workflow identity

- **WHEN** the tag workflow stages with provenance without `NPM_TOKEN`
- **THEN** npm verifies the configured workflow identity for each package and both versions await maintainer approval. Approved artifacts have verifiable provenance. A trust mismatch stops publication

#### Scenario: Temporary token

- **WHEN** the tag workflow stages with `NPM_TOKEN` set
- **THEN** builds and tests run without the token and both versions still await maintainer approval with provenance

#### Scenario: Clean install

- **WHEN** a reviewer installs the released library or invokes either documented MCP entry from a clean supported Node environment
- **THEN** the library imports and both CLI forms reach the same MCP implementation, with registry provenance verifiable for both packages

#### Scenario: Resume a partially published tag

- **WHEN** the library is already published for the tag and the scoped package is missing
- **THEN** the workflow verifies the existing version, digest and provenance before publishing the missing package, and stops on a mismatch

