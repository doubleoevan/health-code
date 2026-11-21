# Node ecosystem delta

## ADDED Requirements

### Requirement: Locate dependency usage and diagnostics

The adapter SHALL derive a usage map in the sandbox identifying importing files, workspaces, exports and call sites. Diagnostic locators for typecheck errors, failed tests and deprecation warnings SHALL link to validated file and line ranges at the original tested commit. Unresolved symbols and unmappable lines SHALL retain their evidence and uncertainty.

#### Scenario: Renamed import in a workspace

- **WHEN** workspace code calls an export through an import alias
- **THEN** the usage map identifies the dependency export and the pinned call site, even when the local name differs.

#### Scenario: Failure points only into generated upgrade output

- **WHEN** no line in the pinned Repository can be verified for a diagnostic
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
