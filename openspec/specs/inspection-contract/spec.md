# inspection-contract Specification

## Purpose
Give a site, an MCP server, or a scheduled worker the same portable inspection result and live progress stream.

## Requirements

### Requirement: Portable, caller-owned inspections

The npm package `health-code` SHALL export its ESM entry and declarations. One options object SHALL carry the repository URL, provider, limits, optional event callback and optional model configuration. Each invocation SHALL own its state and leave persistence to the caller. Existing options, including the reserved string dictionary, SHALL retain model-free version 1 behavior. Supplying the four structured roles SHALL opt into model execution and the version 2 report/event contract.

#### Scenario: Two independent consumers

- **WHEN** Node and Bun consumers import the packed artifact and inspect with different providers, callbacks and limits
- **THEN** each receives only its own evidence and events, with equivalent JSON for equivalent inputs apart from execution metadata.

#### Scenario: No ambient application configuration

- **WHEN** a caller supplies its provider explicitly and leaves the process environment empty
- **THEN** inspection reads no ambient application settings or model credentials, including when the caller supplies configured model handles or routes.

#### Scenario: Existing models dictionary and exhaustive event handling

- **WHEN** a version 1 caller supplies a dictionary of model strings, a legacy provider and an exhaustive version 1 callback
- **THEN** the packed library preserves the call's types and runtime behavior, makes no model calls and emits replayable version 1 JSON.

### Requirement: Pin a public repository

The library SHALL accept a public GitHub HTTPS repository URL and pin the default branch head to one full commit identifier before executing repository code. All results within the inspection SHALL refer to that commit.

#### Scenario: A branch moves

- **WHEN** the default branch advances between the Baseline and an Upgrade Check
- **THEN** both use the original commit and the Inspection Report identifies that commit

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
- **THEN** their sequence, payloads, and terminal event match the Inspection Report timeline, including confirmed sandbox deletion before completion

#### Scenario: Runtime controls are visible

- **WHEN** a sandbox is created, verified credential-free, network-locked, confirmed to have blocked a connection, or deleted
- **THEN** the corresponding Sandbox Event identifies the action so a consumer can highlight and pin it

### Requirement: Versioned evidence

An Inspection Report SHALL include a schema version, repository, inspected commit, package manager or detection reason, Baseline, upgrade selection, per-upgrade evidence and Check Results, and the full emitted timeline. Each upgrade SHALL identify its dependency, source versions, target version, install findings, and typecheck and test results. Failed results SHALL carry evidence and untested results SHALL carry a reason.

#### Scenario: Store and replay

- **WHEN** a caller serializes a report to JSON, reads it back, and encounters an additional optional field
- **THEN** it can recover the same checks and replay the timeline without consulting the provider or interpreting the extra field

#### Scenario: Provider failure before a usable inspection

- **WHEN** a provider rejects an expired token during an accepted inspection
- **THEN** the promise rejects with a typed sandbox-unavailable error after cleanup is attempted, and the timeline ends in inspection failure

### Requirement: Developer inspection command

The repository SHALL provide `bun run inspect <repo-url> [--fake]` through a development script that calls the public package, displays Inspection Events, and saves the returned Inspection Report as JSON under `logs/`.

#### Scenario: Interactive and recorded output

- **WHEN** a developer invokes the command in a terminal
- **THEN** the active step updates in place and the completed steps remain visible. Redirected output contains readable log lines.

#### Scenario: Fixture replay

- **WHEN** the developer selects `--fake` without credentials
- **THEN** the command identifies the replay, saves the fixture Inspection Report under a distinct filename, and prints its path

### Requirement: Version 2 events preserve the inspection lifecycle

A configured Inspection SHALL emit typed reading, matching, per-role Agent Attempt and final patch check steps, with ordered starts/finishes, correlated IDs, statuses and durations. The agent startup Sandbox Event SHALL record the verified credential-isolation action and be available for highlighting and pinning in the live log and Inspection Report. Delivery and replay SHALL retain the existing single terminal event and cleanup guarantees.

#### Scenario: Feature adoption after a repair

- **WHEN** a confirmed repair is followed by an adoption attempt
- **THEN** a consumer can distinguish both attempts, their startup events, costs, final checks and outcomes for the same Upgrade and replay them in original order.

### Requirement: Return the evidence for every version 2 upgrade

Each version 2 upgrade SHALL retain the original Check Results and include the cited release summary, Code Feature Matches, locators, installed-size delta, final Verdict, dependency reviews, accepted Patches and application prompts, diagnosis when applicable, and usage and cost per step. A missing measurement or skipped phase SHALL carry a reason. Customer copy SHALL describe what passed inspection and cite its evidence.

#### Scenario: An initially broken upgrade becomes green

- **WHEN** a repair passes its final check
- **THEN** the serialized Inspection Report shows the original reproduced failure, the final independent evidence, the reviewed commits and the resulting Verdict.

#### Scenario: Old report opened after upgrading the library

- **WHEN** a consumer opens a stored version 1 Inspection Report
- **THEN** it can still replay the original timeline and checks without inventing release summaries, model usage or Verdicts.

#### Scenario: An Inspection selects two targets of one dependency

- **WHEN** a minor and a major Upgrade are both selected
- **THEN** each target retains its own installation evidence, Verdict, model usage and Patches.

#### Scenario: One Inspection Report separates results, evidence and cost

- **WHEN** a consumer presents a version 2 Inspection Report
- **THEN** it identifies direct and inferred replacements, source locations, affected call sites, adoption outcomes and added dependencies using the recorded evidence. Patch verification identifies the applicable and tested commits and any required upgrade patch. Model cost and reserved upper bound have separate labels, and output tokens report measured usage.

### Requirement: Identify verified Model Request Sandbox startup

An Inspection using a Model Request Sandbox SHALL emit exactly one version 2 Sandbox Event with action `model-request-sandbox-started` after verifying the model request sandbox’s first model-host policy and credential binding. It SHALL identify the Inspection and model request sandbox. Live consumers and the replayed timeline SHALL pin and highlight the event and explain that the model key is supplied remotely.

#### Scenario: A client follows and replays an Inspection

- **WHEN** the first model request sandbox becomes ready and handles several model calls
- **THEN** live and saved timelines identify the same model request sandbox startup once, distinguish it from an Agent Attempt starting, and preserve the terminal event after cleanup.

#### Scenario: No verified model request sandbox exists

- **WHEN** local mode is used, no model request qualifies, or the provider cannot verify the initial binding
- **THEN** the timeline contains no model request sandbox startup claim. Existing version 1 event consumers retain their original event contract.

### Requirement: Account for model request sandbox lifetime in the Inspection

An Inspection SHALL budget for both sandboxes, model requests and cleanup. Its version 2 Inspection Report SHALL include both runtime costs once, show the Model Request Sandbox lifetime and cost basis, and distinguish measured charges from reservations. It SHALL record the measurement cutoff in `runtimeUsage.usageAsOf` and display it as **Usage measured through**.

#### Scenario: Insufficient budget before allocation

- **WHEN** the remaining allowance cannot cover the model request sandbox runtime bound, the model request and teardown
- **THEN** the Inspection records the limiting condition before creating a model request sandbox or dispatching the request. An Inspection that never allocates a model request sandbox incurs zero model request sandbox cost.

#### Scenario: Two runtimes overlap

- **WHEN** the sandbox runs for ten minutes and the model request sandbox runs for two minutes within that interval
- **THEN** billing uses each resource’s own duration, size and rounding policy. The total includes both runtime costs and each metered model request once. Inspection wall time counts the overlap once.

#### Scenario: Missing telemetry or a lost reply

- **WHEN** an allocated model request sandbox has no final receipt, deletion is uncertain, or a dispatched model response is lost
- **THEN** the report or terminal failure retains the corresponding upper bound and its basis. Available lifetime and usage evidence survives the failure. Consumers can still open historical reports that omit model request sandbox fields.

### Requirement: Inspect the caller’s resolved commit

Callers SHALL be able to supply an optional full Git commit SHA to the public Inspection options. The library SHALL verify that checkout matches before running project code and return the verified SHA in its Inspection Report. Omitting this option SHALL preserve normal inspected checkout.

#### Scenario: Requested revision unavailable

- **WHEN** the provider cannot check out the requested SHA
- **THEN** the Inspection fails before project commands run and releases its sandbox

### Requirement: Resolve versioned prompts per Inspection

Every model-facing prompt authored by the library SHALL come from a named, versioned Markdown template. A caller MAY override a known name with validated versioned source on one Inspection. Defaults SHALL require no caller configuration. Every effective model prompt dispatched SHALL be identifiable by name, version and content digest in the resulting report. Prepared downstream handoff instructions SHALL be identifiable separately.

#### Scenario: Two callers override the same role differently

- **WHEN** concurrent Inspections supply different sources for the same role
- **THEN** each uses and records its own effective source, preserving per-call evidence fences and excluding template contents from the public provenance list

#### Scenario: Invalid override

- **WHEN** an override supplies an unknown name or invalid frontmatter
- **THEN** the library rejects it before allocating a sandbox or calling a model

#### Scenario: No model call

- **WHEN** a valid Inspection completes without dispatching a model prompt
- **THEN** its list of dispatched templates is empty

### Requirement: Caller-owned optional tracing

The library SHALL accept an optional OpenTelemetry tracer, use it per Inspection for AI SDK generation, and correlate host, inspection sandbox and Model Request Sandbox calls where used. It SHALL work with tracing disabled by default, with no environment access, storage, required exporter or global tracer registration.

#### Scenario: Trace isolation

- **WHEN** two callers use different tracers concurrently and a third omits tracing
- **THEN** each configured tracer receives only its own bounded call metadata, the third delivers no spans, and prompt bodies, model outputs and credentials are excluded

### Requirement: Report model and sandbox costs separately

An Inspection SHALL expose available model and sandbox cost evidence, its currency and its basis. Missing measurements SHALL be distinguishable from confirmed zero cost and from reserved upper bounds.

#### Scenario: Provider supplies only an upper bound

- **WHEN** measured sandbox billing is unavailable when the Inspection terminates
- **THEN** the consumer can distinguish the sandbox estimate or outstanding liability from measured model spend and reconcile it later
