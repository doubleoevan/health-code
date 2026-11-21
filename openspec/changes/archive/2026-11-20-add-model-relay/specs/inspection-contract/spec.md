# Inspection contract

## ADDED Requirements

### Requirement: Identify verified Model Request Sandbox startup

An Inspection using a Model Request Sandbox SHALL emit exactly one version 2 Sandbox Event with action `model-request-sandbox-started` after verifying the model request sandbox’s first model-host policy and credential binding. It SHALL identify the Inspection and model request sandbox. Live consumers and the replayed timeline SHALL pin and highlight the event and explain that the model key is supplied remotely.

#### Scenario: A client follows and replays an Inspection

- **WHEN** the first model request sandbox becomes ready and handles several model calls
- **THEN** live and saved timelines identify the same model request sandbox startup once, distinguish it from an Agent Attempt starting, and preserve the terminal event after cleanup.

#### Scenario: No verified model request sandbox exists

- **WHEN** local mode is used, no model request qualifies, or the provider cannot verify the initial binding
- **THEN** the timeline contains no model request sandbox startup claim. Existing version 1 event consumers retain their original event contract.

### Requirement: Account for model request sandbox lifetime in the Inspection

An Inspection SHALL budget for both sandboxes, model requests and cleanup. Its version 2 Report Card SHALL include both runtime costs once, show the Model Request Sandbox lifetime and cost basis, and distinguish measured charges from reservations. It SHALL record the measurement cutoff in `runtimeUsage.usageAsOf` and display it as **Usage as of**.

#### Scenario: Insufficient budget before allocation

- **WHEN** the remaining allowance cannot cover the model request sandbox runtime bound, the model request and teardown
- **THEN** the Inspection records the limiting condition before creating a model request sandbox or dispatching the request. An Inspection that never allocates a model request sandbox incurs zero model request sandbox cost.

#### Scenario: Two runtimes overlap

- **WHEN** the sandbox runs for ten minutes and the model request sandbox runs for two minutes within that interval
- **THEN** billing uses each resource’s own duration, size and rounding policy. The total includes both runtime costs and each metered model request once. Inspection wall time counts the overlap once.

#### Scenario: Missing telemetry or a lost reply

- **WHEN** an allocated model request sandbox has no final receipt, deletion is uncertain, or a dispatched model response is lost
- **THEN** the report or terminal failure retains the corresponding upper bound and its basis. Available lifetime and usage evidence survives the failure. Consumers can still open historical cards that omit model request sandbox fields.
