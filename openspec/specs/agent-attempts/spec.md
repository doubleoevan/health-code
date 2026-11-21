# agent-attempts Specification

## Purpose
Let a caller fund bounded work to repair a confirmed dependency break or adopt a verified feature in its repository.

## Requirements

### Requirement: Dispatch four caller-selected roles

A configured Inspection SHALL use the caller's models for release summaries, feature matching, repair and feature adoption. Summaries and matching SHALL execute in the caller process. Repair and feature adoption SHALL execute inside the sandbox with bounded repository editing and checking tools. Model providers, endpoints and model IDs SHALL come from the caller.

#### Scenario: Two consumers choose different routes

- **WHEN** one caller uses the same model for every role and another uses a custom OpenAI-compatible endpoint for matching and adoption
- **THEN** each role uses its caller's route and execution location, with credentials and usage isolated between callers.

The public Agent Attempt role IDs SHALL be `repair` and `featureAdoption`. Their display labels SHALL be **Repair** and **Feature adoption**. Each role accepts `maxTurns` as its turn limit.

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
- **THEN** the Feature Match keeps its permalink and reason, and the green upgrade and its Patch remain available.
