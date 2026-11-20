# inspection-contract Specification

## Purpose
Give a site, an MCP server, or a scheduled worker the same portable inspection result and live progress stream.

## Requirements

### Requirement: Portable, caller-owned inspections

The library SHALL expose its public ESM entry and declarations at the npm package name `health-code`. One options object SHALL carry the repository URL, provider, limits, optional event callback, and reserved models field. Each invocation SHALL own its state and perform no consumer persistence or model calls.

#### Scenario: Two independent consumers

- **WHEN** Node and Bun consumers import the packed artifact and inspect with different providers, callbacks, and limits
- **THEN** each receives only its own evidence and events, with equivalent JSON for equivalent inputs apart from execution metadata

#### Scenario: No ambient application configuration

- **WHEN** a caller supplies its provider explicitly and leaves the process environment empty
- **THEN** inspection proceeds without reading application settings or model credentials, including when the caller supplies model configuration

### Requirement: Pin a public repository

The library SHALL accept a public GitHub HTTPS repository URL and pin the default branch head to one full commit identifier before executing repository code. All results within the inspection SHALL refer to that commit.

#### Scenario: A branch moves

- **WHEN** the default branch advances between the Baseline and an Upgrade Check
- **THEN** both use the original commit and the Report Card identifies that commit

#### Scenario: Unacceptable source

- **WHEN** the URL embeds credentials, names an unsupported host, or identifies a private or unavailable repository
- **THEN** the caller receives a typed error and no repository code executes

### Requirement: Ordered Inspection Events

Each accepted inspection SHALL emit ordered, JSON-serializable events for inspection start, step start, step finish, detail, Sandbox Event, and exactly one terminal success or failure. Step finishes SHALL carry a summary and duration. Buffered command output SHALL be delivered as bounded detail with stream and truncation metadata.

#### Scenario: Step boundaries are live

- **WHEN** a command is still executing
- **THEN** the caller has already received its labeled step start, and receives captured output only after it becomes available

#### Scenario: Timeline equality

- **WHEN** the caller records events for a completed inspection
- **THEN** their sequence, payloads, and terminal event match the Report Card timeline, including confirmed sandbox deletion before completion

#### Scenario: Runtime controls are visible

- **WHEN** a sandbox is created, verified credential-free, network-locked, confirmed to have blocked a connection, or deleted
- **THEN** the corresponding Sandbox Event identifies the action so a consumer can highlight and pin it

### Requirement: Versioned evidence

A Report Card SHALL include a schema version, repository, pinned commit, package manager or detection reason, Baseline, candidate selection, per-upgrade evidence and Check Results, and the full emitted timeline. Each upgrade SHALL identify its dependency, source versions, target version, install findings, and typecheck and test results. Failed results SHALL carry evidence and untested results SHALL carry a reason.

#### Scenario: Store and replay

- **WHEN** a caller serializes a card to JSON, reads it back, and encounters an additional optional field
- **THEN** it can recover the same checks and replay the timeline without consulting the provider or interpreting the extra field

#### Scenario: Provider failure before a usable inspection

- **WHEN** a provider rejects an expired token during an accepted inspection
- **THEN** the promise rejects with a typed sandbox-unavailable error after cleanup is attempted, and the timeline ends in inspection failure

### Requirement: Developer inspection command

The repository SHALL provide `bun run inspect <repo-url> [--fake]` through a development script that calls the public package, displays Inspection Events, and saves the returned Report Card as JSON under `logs/`.

#### Scenario: Interactive and recorded output

- **WHEN** a developer invokes the command in a terminal
- **THEN** the active step updates in place and the completed steps remain visible. Redirected output contains readable log lines.

#### Scenario: Fixture replay

- **WHEN** the developer selects `--fake` without credentials
- **THEN** the command identifies the replay, saves the fixture Report Card under a distinct filename, and prints its path
