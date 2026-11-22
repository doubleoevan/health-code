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

The engine SHALL capture install, applicable typecheck, and test results at the pinned commit before attributing failures to upgrades. A failed Baseline install SHALL prevent upgrade checks. If the install succeeds and the required Baseline build fails, Health Code SHALL retain independent upgrade install and test evidence and mark the overall comparison partial.

#### Scenario: Broken Baseline install

- **WHEN** frozen install fails
- **THEN** the report lists each selected upgrade as skipped and explains why

#### Scenario: Broken Baseline build

- **WHEN** frozen install succeeds and the required Baseline build fails
- **THEN** the report shows the independent install and test results, the skipped typecheck and an Untested Verdict

#### Scenario: Sandbox loss during checks

- **WHEN** the sandbox becomes unavailable after checkout and network lockdown and deletion succeeds
- **THEN** the engine may start one replacement under the original time and spend limits, pin the same commit, lock the network, measure its baseline again and finish outstanding upgrades serially. Untouched upgrades precede the interrupted target. A partial report retains completed evidence and lists selected upgrades that never started

#### Scenario: Known Baseline failures

- **WHEN** the Baseline has named failing tests or file-load failures
- **THEN** the Inspection Report retains their identities and excludes those failures when comparing the upgraded project

### Requirement: Gate each Upgrade Check on installation evidence

Each Install Check SHALL observe the candidate's install under the registry-only network policy. A connection attempt outside the policy or a file written outside the project SHALL stop that candidate. An incomplete observation SHALL preclude a passed result.

#### Scenario: Unexpected installation activity

- **WHEN** an install succeeds but attempts a connection to an unlisted host or writes outside the project
- **THEN** the Install Check records the finding, the Upgrade Check is untested with the reason, and other candidates can proceed from a clean state

#### Scenario: Observation unavailable

- **WHEN** monitoring loses part of the command tree or cannot resolve whether a destination was allowed
- **THEN** the Install Check and Upgrade Check record the missing evidence and the upgrade is untested. If installation succeeds with no recorded finding, the adapter runs the available candidate checks under the locked network policy and keeps their results as partial evidence.

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

### Requirement: Assign one evidence-backed Verdict

Each version 2 Upgrade SHALL receive one of Passes as is, Fixed, Fixed with test changes, Can't fix or Untested. The Verdict SHALL retain the named test failures already present in the Baseline, the original Check Result, and the final evidence. Both fixed outcomes SHALL identify each added dependency, version, rationale and commit. An unsuccessful adoption SHALL preserve the verified upgrade outcome.

#### Scenario: Green upgrade plus accepted feature

- **WHEN** the bump alone passes and a separate adoption patch qualifies
- **THEN** the upgrade receives Passes as is and reports the independently tested adoption and simplification on top.

#### Scenario: Recorded regression is repaired

- **WHEN** an upgrade introduces a reproduced failure and the final tree passes with a code fix and no changed existing test
- **THEN** the Verdict is Fixed and identifies all new dependencies with their commit and reason.

#### Scenario: Existing test requires an approved behavior change

- **WHEN** an accepted fix changes a previously passing test to cover a documented new behavior
- **THEN** the Verdict is Fixed with test changes and identifies the separately flagged commit for review.

#### Scenario: The initial comparison is inconclusive

- **WHEN** a Baseline cannot build, there are zero executed tests, or a new failure cannot be confirmed
- **THEN** the Verdict is Untested with the reason and supporting evidence.

#### Scenario: Adoption rejected after an accepted repair

- **WHEN** an adoption fails its independent check after the repair was accepted
- **THEN** the repair Verdict and upgrade Patch remain available and the Code Feature Match explains why no feature Patch was retained.

#### Scenario: A confirmed break persists at the ceiling

- **WHEN** repair reaches the time, cost or turn limit and the confirmed regression persists
- **THEN** the Verdict is Can't fix, with diagnosis and attempts and no partial Patch.

### Requirement: List available upgrades and test one choice

The public library SHALL expose `listUpgrades` to return the inspected commit and the eligible dependencies with source-linked release features. `getUpgrade` SHALL accept a target from that list and its commit, run the checks for that target and return the inspection report with any verified patches. Both operations SHALL deliver inspection status through `onEvent`.

#### Scenario: Test a single version from an upgrade menu

- **WHEN** a library consumer chooses one dependency and target version from an upgrade menu
- **THEN** the consumer can follow the checks at the listed commit as they run and read the selected upgrade’s verified patches or the reason verification stopped
