## ADDED Requirements

### Requirement: Inspect the caller’s resolved commit

Callers SHALL be able to supply an optional full Git commit SHA to the public Inspection options. The library SHALL verify that checkout matches before running project code and return the verified SHA in its Report Card. Omitting this option SHALL preserve normal pinned checkout.

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
