## MODIFIED Requirements

### Requirement: Collect repository-owned typecheck and test evidence

The adapter SHALL invoke the project's own TypeScript compiler when a project config exists, and its declared test script when present. It SHALL capture per-test results from Bun, Vitest, Jest or Node's test runner when supported, file-level load failures, or command exit evidence otherwise.

#### Scenario: Compiler selection

- **WHEN** a project has a tsconfig with project references
- **THEN** its local compiler performs a build with `-b`. A project with a tsconfig and no references uses `--noEmit`. A project without a tsconfig records the typecheck as inapplicable

#### Scenario: Failed suite before test discovery

- **WHEN** a supported runner fails to load a test file without producing named cases
- **THEN** the Check Result identifies the workspace and relative file so the engine can compare the same failure after an Upgrade

#### Scenario: Missing script or opaque test runner

- **WHEN** the project omits its test script
- **THEN** tests are untested with that reason. A declared script with an unsupported reporter still executes and records its exit status at command granularity

#### Scenario: Runner after a build step

- **WHEN** the test script runs other commands with `&&` before a supported runner
- **THEN** the adapter passes the reporter to that runner and records its cases

#### Scenario: Node test runner

- **WHEN** the test script ends with a plain `node --test` or `tsx --test` command
- **THEN** the adapter records each case with its suite path and each file that failed to load
