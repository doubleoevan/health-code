# agent-attempts Specification

## Purpose
Let a caller fund bounded work to repair a confirmed dependency break or adopt a verified feature in its repository.

## Requirements

### Requirement: Dispatch four caller-selected roles

A configured Inspection SHALL use the caller’s models, endpoints and pricing. Release summaries and Code Feature Matches SHALL use the caller’s process by default, or a Model Request Sandbox when selected. Repair and Feature adoption SHALL execute inside the repository sandbox with bounded editing and checking tools.

#### Scenario: Two consumers choose different routes

- **WHEN** one caller supplies local model handles and another selects the model request sandbox with a custom OpenAI-compatible model route
- **THEN** each role uses its caller’s selected model and execution location. Credentials, responses and usage stay isolated between callers.

The public Agent Attempt role IDs SHALL be `repair` and `featureAdoption`. Their display labels SHALL be **Repair** and **Feature adoption**. Each role accepts `maxTurns` as its turn limit.

#### Scenario: Existing callers upgrade the library

- **WHEN** the web app or CarlNotes supplies existing model handles and omits `callerModelExecution`, or explicitly selects `"local"`
- **THEN** the caller receives the same version 2 model behavior with a provider that has no model request sandbox capability. A model-free caller still receives the version 1 contract.

#### Scenario: A caller selects the model request sandbox

- **WHEN** `callerModelExecution` is `"modelRequestSandbox"` and the two caller-side roles supply valid serializable routes and prices
- **THEN** the library sends each eligible role through the model request sandbox. It builds and validates each bounded, nonce-fenced prompt and result by the same rules as local mode. Repair and Feature adoption continue using their own credential sessions.

#### Scenario: One summary informs one match request

- **WHEN** an Upgrade has release notes and inspected usage
- **THEN** its summary is processed before its separate matching request. Each role has its own pricing, model receipt, output bound and validated citations. An Upgrade with no usage skips matching. Missing release evidence skips both requests.

#### Scenario: Incompatible caller options

- **WHEN** a caller selects model request sandbox execution with local handles, invalid routes or a provider lacking the capability
- **THEN** the library returns a typed configuration error before allocating resources or sending paid requests. Model request sandbox authentication and transport failures never trigger a local model request.

### Requirement: Admit and account for paid work

The engine SHALL enforce caller time, cost and turn limits, including retries, across the Inspection and each Agent Attempt. It SHALL reserve an upper bound before dispatch and record per-step token usage, timing, charge basis and unresolved cost. Unavailable usage SHALL never appear as zero spend.

#### Scenario: An Inspection with models uses the defaults

- **WHEN** the caller supplies structured models and omits limits
- **THEN** the Inspection allows at most 60 minutes and $15 total, a repair attempt allows 40 turns, 20 minutes and $4, and a feature adoption attempt allows 25 turns, 10 minutes and $2. Each repair or feature adoption reply allows up to 8,192 output tokens. The engine reserves the maximum charge before dispatch and bills actual usage when available.

#### Scenario: Caller lowers one or more caps

- **WHEN** a caller sets `limits.agent.repair.maxTurns` to eight and limits the Inspection to $3
- **THEN** repair stops by its eighth turn or an earlier applicable limit, and every role shares the remaining $3 with VM work and cleanup.

#### Scenario: A call would exceed the remaining budget

- **WHEN** the bounded maximum request cost would consume cleanup funds or exceed an attempt or inspection ceiling
- **THEN** no request starts, the stop reason appears in the timeline and the sandbox can be released.

#### Scenario: A model reply is lost

- **WHEN** a paid request lacks authoritative usage
- **THEN** its reservation remains visible as a bound, further paid work for the attempt stops, and delayed telemetry cannot retroactively authorize work.

### Requirement: Repair confirmed upgrade failures

The repair agent SHALL work from the confirmed failing upgrade, its evidence and its cited release changes. The engine SHALL accept a repair only when applicable checks and the final patch check pass. Each new direct dependency SHALL carry its own flagged commit, reason and reviewed install evidence.

#### Scenario: Replacement library is needed

- **WHEN** a repair replaces a removed API with a new direct dependency
- **THEN** the accepted fix identifies the dependency, version, reason and flagged commit on its Verdict.

#### Scenario: Attempts exhaust their ceiling

- **WHEN** a confirmed failure persists at the ceiling
- **THEN** the result gives the failing tests or diagnostics, supported breaking-change diagnosis and attempted fixes, without a partial patch.

### Requirement: Retain demonstrably simpler feature adoption

Feature adoption SHALL begin only from an Upgrade that passed its checks. It SHALL retain a feature Patch only when applicable checks stay green, the final patch check passes and the feature removes production source lines, a direct dependency or a deprecated call relative to that upgrade.

#### Scenario: Fewer production lines with the same tests

- **WHEN** a matched feature replaces a workaround, meets the normalized line metric and passes verification
- **THEN** the feature Patch records the before/after metric and applies on top of the accepted upgrade.

#### Scenario: Feature edit lacks a benefit

- **WHEN** an adoption changes formatting only, fails tests or exhausts its budget
- **THEN** the Code Feature Match keeps its permalink and reason, and the green upgrade and its Patch remain available.
