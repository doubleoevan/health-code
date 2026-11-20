# upgrade-inspection Specification

## Purpose
Show which upgrades passed at the pinned commit, which introduced reproducible failures, and where the available evidence stops.

## Requirements

### Requirement: Select a bounded set of upgrades

An inspection SHALL select at most six distinct dependency and target pairs by default, permit a caller-supplied cap, and record the eligible, selected, and omitted candidates in deterministic order.

#### Scenario: More candidates than slots

- **WHEN** the same pinned project and registry metadata yield more eligible candidates than the cap
- **THEN** repeated selections choose the same candidates, with eligible minor upgrades before major upgrades and dependency name breaking ties

### Requirement: Establish a comparable Baseline

The engine SHALL capture install, applicable typecheck, and test results at the pinned commit before attributing failures to upgrades. A failed Baseline install or build SHALL make every selected Upgrade untested.

#### Scenario: Broken Baseline build

- **WHEN** frozen install or the required Baseline build fails
- **THEN** each selected Upgrade is untested with the Baseline reason and the engine performs no upgrade installations

#### Scenario: Known Baseline failures

- **WHEN** the Baseline has named failing tests or file-load failures
- **THEN** the Report Card retains their identities and excludes those failures when comparing the upgraded project

### Requirement: Gate each Upgrade Check on installation evidence

Each Install Check SHALL observe the candidate's install under the registry-only network policy. A connection attempt outside the policy or a file written outside the project SHALL stop that candidate. An incomplete observation SHALL preclude a passed result.

#### Scenario: Unexpected installation activity

- **WHEN** an install succeeds but attempts a connection to an unlisted host or writes outside the project
- **THEN** the Install Check records the finding, the Upgrade Check is untested with the reason, and other candidates can proceed from a clean state

#### Scenario: Observation unavailable

- **WHEN** monitoring loses part of the command tree or cannot resolve whether a destination was allowed
- **THEN** the Install Check and Upgrade Check record the missing evidence and the upgrade is untested

### Requirement: Confirm new failures and restore state

An Upgrade Check SHALL bump, install, typecheck, and test a single candidate from the pinned Baseline. It SHALL repeat a newly failing check once on equivalent inputs and attribute only matching failures. A later candidate SHALL start with clean project, process, and writable sandbox state.

#### Scenario: Existing, flaky, and confirmed failures

- **WHEN** the Baseline failed test A, the candidate fails A, B and C, and its rerun fails A and C
- **THEN** the report attributes only C to the Upgrade, records B as unconfirmed, and preserves both observations

#### Scenario: Opaque baseline test failure

- **WHEN** the Baseline and upgraded test scripts both fail and the runner supplies only an exit code
- **THEN** attribution is untested with the reason and both exit results are retained

#### Scenario: Candidate writes to the sandbox

- **WHEN** a failed candidate changes the lockfile, leaves generated files, or starts a background process
- **THEN** the next candidate sees the original commit and baseline inputs, without the previous candidate's files or processes

#### Scenario: Deadline interrupts confirmation

- **WHEN** the engine reaches the caller's budget before the confirming check completes
- **THEN** the new failure is unconfirmed, affected upgrades are untested with the limit reason, and teardown proceeds
