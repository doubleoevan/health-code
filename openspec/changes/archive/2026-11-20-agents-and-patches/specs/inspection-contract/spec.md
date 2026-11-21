# Inspection contract delta

## MODIFIED Requirements

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

## ADDED Requirements

### Requirement: Version 2 events preserve the inspection lifecycle

A configured Inspection SHALL emit typed reading, matching, per-role Agent Attempt and final patch check steps, with ordered starts/finishes, correlated IDs, statuses and durations. The agent startup Sandbox Event SHALL record the verified credential-isolation action and be available for highlighting and pinning in the live log and Report Card. Delivery and replay SHALL retain the existing single terminal event and cleanup guarantees.

#### Scenario: Feature adoption after a repair

- **WHEN** a confirmed repair is followed by an adoption attempt
- **THEN** a consumer can distinguish both attempts, their startup events, costs, final checks and outcomes for the same Upgrade and replay them in original order.

### Requirement: Return the evidence for every version 2 upgrade

Each version 2 upgrade SHALL retain the original Check Results and include the cited release summary, Feature Matches, locators, installed-size delta, final Verdict, dependency reviews, accepted Patches and application prompts, diagnosis when applicable, and usage and cost per step. A missing measurement or skipped phase SHALL carry a reason. Customer copy SHALL describe what passed inspection and cite its evidence.

#### Scenario: An initially broken upgrade becomes green

- **WHEN** a repair passes its final check
- **THEN** the serialized Report Card shows the original reproduced failure, the final independent evidence, the reviewed commits and the resulting Verdict.

#### Scenario: Old report opened after upgrading the library

- **WHEN** a consumer opens a stored version 1 Report Card
- **THEN** it can still replay the original timeline and checks without inventing release summaries, model usage or Verdicts.

#### Scenario: An Inspection selects two targets of one dependency

- **WHEN** a minor and a major Upgrade are both selected
- **THEN** each target retains its own installation evidence, Verdict, model usage and Patches.


#### Scenario: One Report Card separates results, evidence and cost

- **WHEN** a consumer presents a version 2 Report Card
- **THEN** it identifies direct and inferred replacements, source locations, affected call sites, adoption outcomes and added dependencies using the recorded evidence. Patch verification identifies the applicable and tested commits and any required upgrade patch. Model cost and reserved upper bound have separate labels, and output tokens report measured usage.
