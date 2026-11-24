# node-ecosystem Specification

## Purpose
Use a JavaScript or TypeScript repository's own package manager, compiler, and tests to produce comparable evidence for its dependency upgrades.

## Requirements

### Requirement: Detect the project from committed inputs

The Node Ecosystem Adapter SHALL detect Bun, pnpm, Yarn, or npm from the root lockfile and include the root and its declared workspaces. It SHALL report an unsupported or ambiguous project with the reason.

#### Scenario: Package manager and workspace discovery

- **WHEN** a repository contains `bun.lock`, `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json` and defines workspaces
- **THEN** the adapter identifies the matching manager and enumerates only workspace manifests inside the inspected checkout, including pnpm workspace patterns

#### Scenario: Competing lockfiles

- **WHEN** different managers have root lockfiles and the committed package manager declaration does not select exactly one of them
- **THEN** the Inspection Report records the ambiguity and the engine skips installation

### Requirement: Install and change one direct dependency

The Baseline SHALL use frozen installation and the selected manager's normal lifecycle policy. When that install fails after attempting an off-registry connection, the adapter SHALL retry without install scripts, use the same policy for every later install and record that scripts were skipped. The final Baseline install result SHALL decide whether upgrade checks run. For an Upgrade the adapter SHALL update the target in every declaring workspace, preserve dependency sections, and regenerate the lockfile with that manager.

#### Scenario: Shared dependency

- **WHEN** two workspaces declare the same registry dependency at different versions
- **THEN** the Upgrade records both original resolutions, the common target and declaring workspaces, and leaves unrelated direct declarations intact

#### Scenario: Install script download

- **WHEN** a postinstall script fails because the locked network blocks its download
- **THEN** the Baseline retries without install scripts, the Upgrade uses the same policy and the report discloses the skipped scripts

#### Scenario: Inconsistent Baseline lockfile

- **WHEN** the chosen manager rejects a frozen install
- **THEN** the adapter records its exit evidence and preserves the committed Baseline inputs

### Requirement: Discover stable registry targets

The adapter SHALL query the public npm registry for direct dependencies and return the latest eligible minor and major targets. It SHALL exclude deprecated releases. It SHALL record unsupported dependency sources or missing version evidence in discovery. When the repository's package manager applies a minimum release age, the adapter SHALL return only targets old enough to install, honoring the repository's exempt package names without caller configuration.

#### Scenario: Stable targets

- **WHEN** the highest locked version is 1.2.0 and the registry contains 1.2.1, 1.4.2, 2.1.0, and 3.0.0-beta.1
- **THEN** the adapter returns 1.4.2 and 2.1.0, each once for the dependency

#### Scenario: Minimum release age

- **WHEN** the repository requires releases to be three days old and the latest minor release was published today
- **THEN** the adapter returns the newest eligible release that is at least three days old

#### Scenario: Workspace link

- **WHEN** a dependency resolves only to a local workspace
- **THEN** it is excluded from registry trials with its source recorded

### Requirement: Collect repository-owned typecheck and test evidence

The adapter SHALL invoke the project's own TypeScript compiler when a project config exists, and its declared test script when present. It SHALL capture per-test results from Bun, Vitest, or Jest when supported, file-level load failures, or command exit evidence otherwise.

#### Scenario: Compiler selection

- **WHEN** a project has a tsconfig with project references
- **THEN** its local compiler performs a build with `-b`. A project with a tsconfig and no references uses `--noEmit`. A project without a tsconfig records the typecheck as inapplicable

#### Scenario: Failed suite before test discovery

- **WHEN** a supported runner fails to load a test file without producing named cases
- **THEN** the Check Result identifies the workspace and relative file so the engine can compare the same failure after an Upgrade

#### Scenario: Missing script or opaque test runner

- **WHEN** the project omits its test script
- **THEN** tests are untested with that reason. A declared script with an unsupported reporter still executes and records its exit status at command granularity

### Requirement: Locate dependency usage and diagnostics

The adapter SHALL derive a usage map in the sandbox identifying importing files, workspaces, exports and call sites. Imports of a dependency subpath and ambient module declarations SHALL count as usage. Diagnostic locators for typecheck errors, failed tests and deprecation warnings SHALL link to validated file and line ranges at the original tested commit. Unresolved symbols and unmappable lines SHALL retain their evidence and uncertainty.

#### Scenario: Renamed import in a workspace

- **WHEN** workspace code calls an export through an import alias
- **THEN** the usage map identifies the dependency export and the inspected call site, even when the local name differs.

#### Scenario: Failure points only into generated upgrade output

- **WHEN** no line in the inspected Repository can be verified for a diagnostic
- **THEN** the report retains the diagnostic and explains the missing locator.

### Requirement: Compare installed dependency sizes

The adapter SHALL measure Baseline and upgraded dependency footprints using the same manager, platform, clean-install conditions and documented method. The report SHALL record both sizes in bytes and the signed difference, or an explicit unavailable reason.

#### Scenario: Workspace paths share installed files

- **WHEN** several workspace paths reach the same physical dependency file
- **THEN** it contributes once per measured tree and symbolic links cannot extend the measurement outside the installation.

### Requirement: Collect a comparable test inventory

version 2 inspections SHALL inventory discovered files and test identities with their execution states, including supported runner patterns, custom roots, conventional test names, skipped cases and file-load failures. Missing discovery or exit-only evidence SHALL identify the limitation.

#### Scenario: Custom test directory and existing load failure

- **WHEN** the configured runner finds a test outside conventional folders and another suite fails to load
- **THEN** the adapter preserves the first case's workspace, file, name and status and the second file's exclusion identity.

#### Scenario: Exit-only test script

- **WHEN** a command succeeds but the adapter cannot establish individual test membership
- **THEN** the command result remains available and the inventory is marked incomplete for patch verification.
