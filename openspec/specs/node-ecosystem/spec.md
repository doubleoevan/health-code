# node-ecosystem Specification

## Purpose
Use a JavaScript or TypeScript repository's own package manager, compiler, and tests to produce comparable evidence for its dependency upgrades.

## Requirements

### Requirement: Detect the project from committed inputs

The Node Ecosystem Adapter SHALL detect Bun, pnpm, Yarn, or npm from the root lockfile and include the root and its declared workspaces. It SHALL report an unsupported or ambiguous project with the reason.

#### Scenario: Package manager and workspace discovery

- **WHEN** a repository contains `bun.lock`, `bun.lockb`, `pnpm-lock.yaml`, `yarn.lock`, or `package-lock.json` and defines workspaces
- **THEN** the adapter identifies the matching manager and enumerates only workspace manifests inside the pinned checkout, including pnpm workspace patterns

#### Scenario: Competing lockfiles

- **WHEN** different managers have root lockfiles and the committed package manager declaration does not select exactly one of them
- **THEN** the Report Card records the ambiguity and the engine skips installation

### Requirement: Install and change one direct dependency

The Baseline SHALL use frozen installation and the selected manager's normal lifecycle policy. For an Upgrade the adapter SHALL update the target in every declaring workspace, preserve dependency sections, and regenerate the lockfile with that manager.

#### Scenario: Shared dependency

- **WHEN** two workspaces declare the same registry dependency at different versions
- **THEN** the Upgrade records both original resolutions, the common target and declaring workspaces, and leaves unrelated direct declarations intact

#### Scenario: Inconsistent Baseline lockfile

- **WHEN** the chosen manager rejects a frozen install
- **THEN** the adapter records its exit evidence and preserves the committed Baseline inputs

### Requirement: Discover stable registry targets

The adapter SHALL query the public npm registry for direct dependencies and return the latest eligible minor and major targets. It SHALL record unsupported dependency sources or missing version evidence in discovery.

#### Scenario: Stable targets

- **WHEN** the highest locked version is 1.2.0 and the registry contains 1.2.1, 1.4.2, 2.1.0, and 3.0.0-beta.1
- **THEN** the adapter returns 1.4.2 and 2.1.0, each once for the dependency

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
