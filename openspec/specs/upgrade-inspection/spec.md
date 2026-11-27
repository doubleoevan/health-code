# upgrade-inspection Specification

## Purpose
Show which upgrades passed at the inspected commit, which introduced reproducible failures, and where the available evidence stops.

## Requirements

### Requirement: Select a bounded set of upgrades

An inspection SHALL select at most six distinct dependency and target pairs by default, permit a caller-supplied cap, and record the eligible, selected, and omitted upgrades in deterministic order.

#### Scenario: More upgrades than slots

- **WHEN** the same inspected project and registry metadata yield more eligible upgrades than the cap
- **THEN** repeated selections choose the same upgrades, with eligible minor upgrades before major upgrades and dependency name breaking ties

### Requirement: Establish a comparable Baseline

The engine SHALL capture install, applicable typecheck, and test results at the inspected commit before attributing failures to upgrades. A failed Baseline install SHALL prevent upgrade checks. If the install succeeds and the required Baseline build fails, Health Code SHALL retain independent upgrade install and test evidence and mark the overall comparison partial. A failed Baseline typecheck whose errors are all identified by file and message SHALL remain comparable.

#### Scenario: Broken Baseline install

- **WHEN** frozen install fails and any retry without install scripts also fails
- **THEN** the report lists each selected upgrade as skipped and explains why

#### Scenario: Broken Baseline build

- **WHEN** frozen install succeeds and the required Baseline build fails without identified errors
- **THEN** the report shows the independent install and test results, the skipped typecheck and an Untested Verdict

#### Scenario: Sandbox loss during checks

- **WHEN** the sandbox becomes unavailable after checkout and network lockdown and deletion succeeds
- **THEN** the engine may start one replacement under the original time and spend limits, use the same commit, lock the network, measure its baseline again and finish outstanding upgrades serially. Untouched upgrades precede the interrupted target. A partial report retains completed evidence and lists selected upgrades that never started

#### Scenario: Known Baseline failures

- **WHEN** the Baseline has named failing tests or file-load failures
- **THEN** the Inspection Report retains their identities and excludes those failures when comparing the upgraded project

#### Scenario: Known Baseline type errors

- **WHEN** the Baseline typecheck reports only identified errors and the upgraded project reports the same errors
- **THEN** the Upgrade Check excludes them and runs its tests. A new error is confirmed and can be repaired

### Requirement: Gate each Upgrade Check on installation evidence

Each Install Check SHALL observe the upgrade's install under the registry-only network policy. A connection attempt outside the policy or a file written outside the project SHALL stop that upgrade. An incomplete observation SHALL preclude a passed result.

#### Scenario: Unexpected installation activity

- **WHEN** an install succeeds but attempts a connection to an unlisted host or writes outside the project
- **THEN** the Install Check records the finding, the Upgrade Check is untested with the reason, and other upgrades can proceed from a clean state

#### Scenario: Observation unavailable

- **WHEN** monitoring loses part of the command tree or cannot resolve whether a destination was allowed
- **THEN** the Install Check and Upgrade Check record the missing evidence and the upgrade is untested. If installation succeeds with no recorded finding, the adapter runs the available upgrade checks under the locked network policy and reports the outcome of each check separately.

### Requirement: Confirm new failures and restore state

An Upgrade Check SHALL bump, install, typecheck, and test a single upgrade from the Baseline. It SHALL repeat a newly failing check once on equivalent inputs and attribute only matching failures. A later upgrade SHALL start with clean project, process, and writable sandbox state.

#### Scenario: Existing, flaky, and confirmed failures

- **WHEN** the Baseline failed test A, the upgrade fails A, B and C, and its rerun fails A and C
- **THEN** the report attributes only C to the Upgrade, records B as unconfirmed, and preserves both observations

#### Scenario: Opaque baseline test failure

- **WHEN** the Baseline and upgraded test scripts both fail and the runner supplies only an exit code
- **THEN** attribution is untested with the reason and both exit results are retained

#### Scenario: Upgrade writes to the sandbox

- **WHEN** a failed upgrade changes the lockfile, leaves generated files, or starts a background process
- **THEN** the next upgrade sees the original commit and baseline inputs, without the previous upgrade's files or processes

#### Scenario: Deadline interrupts confirmation

- **WHEN** the engine reaches the caller's budget before the confirming check completes
- **THEN** the new failure is unconfirmed, affected upgrades are untested with the limit reason, and teardown proceeds

### Requirement: Assign one evidence-backed Verdict

Each version 2 Upgrade SHALL receive one of Passes as is, Fixed, Fixed with test changes, Can't fix or Untested. The Verdict SHALL retain the named test failures already present in the Baseline, the original Check Result, and the final evidence. Both fixed outcomes SHALL identify each added or jointly upgraded dependency, version, rationale and commit. An unsuccessful adoption SHALL preserve the verified upgrade outcome.

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

The public library SHALL expose `listUpgrades` to return the inspected commit and the eligible dependencies without a Sandbox Provider. Callers SHALL read source-linked release features for the choices they show through a separate call. `getUpgrade` SHALL accept a target from that list and its commit, run the checks for that target in one repository sandbox and return the inspection report with any verified patches. Both operations SHALL deliver inspection status through `onEvent`.

#### Scenario: Test a single version from an upgrade menu

- **WHEN** a library consumer chooses one dependency and target version from an upgrade menu
- **THEN** the consumer can follow the checks at the listed commit as they run and read the selected upgrade’s verified patches or the reason verification stopped

#### Scenario: List without an account

- **WHEN** a library consumer lists upgrades with no Runta account
- **THEN** the consumer receives the upgrade menu and no sandbox is allocated

#### Scenario: Release features for visible choices

- **WHEN** a consumer shows four dependencies from a 200-dependency upgrade menu
- **THEN** the consumer reads release features for those four and the menu call itself read none

### Requirement: Reject a stale selection with a refresh instruction

`getUpgrade` SHALL reject a selected target when the checkout's locked versions differ from the target's source versions. The message SHALL name the dependency and say to refresh the Upgrade menu and select again.

#### Scenario: Locked version changed

- **WHEN** a target lists a dependency at 1.2.0 and the checkout at the supplied commit locks it at 1.3.0
- **THEN** no install runs and the result says to refresh the Upgrade menu

### Requirement: Accept any eligible published version as a target

A selected target SHALL be eligible when the registry lists the version, it is not deprecated, it is not a prerelease, it is above the highest locked version among the declaring workspaces and it passes the Minimum release age. Patch releases SHALL qualify and SHALL be recorded with the kind `patch`. The Upgrade menu SHALL keep listing only the newest eligible minor and the newest eligible major.

#### Scenario: A patch release the menu does not list

- **WHEN** a caller selects 4.17.21 for a dependency locked at 4.17.19 and the menu lists only 4.18.0
- **THEN** the checks run for 4.17.21 and the Inspection Report records the Upgrade with the kind `patch`

#### Scenario: A version behind one workspace

- **WHEN** two workspaces lock a dependency at 1.2.0 and 1.4.0 and the caller selects 1.3.0
- **THEN** the target is rejected because it does not advance every declaring workspace

#### Scenario: Rejected in the sandbox

- **WHEN** `getUpgrade` receives a version that is unpublished, deprecated, a prerelease or not newer
- **THEN** it rejects the target before the Baseline and no install or model request runs

#### Scenario: Registry out of reach in the sandbox

- **WHEN** the sandbox cannot read the registry's record for the selected version
- **THEN** the checks run and the Install Check decides, as it did before this change

#### Scenario: Target without source versions

- **WHEN** a caller passes a dependency and a version with no source versions
- **THEN** the sandbox validates the version against the checkout's locked versions

### Requirement: Resolve a named version without a sandbox

The library SHALL validate one named dependency version at a commit in the caller's process and return the Upgrade with its source versions and kind. A rejected version SHALL produce a typed error whose message states the reason and which carries the eligible dependency versions, newest first.

#### Scenario: Eligible

- **WHEN** a caller resolves a stable version that is published, newer and old enough
- **THEN** the call returns the Upgrade and allocates no sandbox

#### Scenario: Too new

- **WHEN** the named version was published inside the Repository's Minimum release age
- **THEN** the error says when it was published, when it becomes eligible and which versions are eligible

#### Scenario: Not a direct dependency

- **WHEN** no workspace declares the named dependency
- **THEN** the error says so and names the commit

### Requirement: End a target the package manager refuses as too new as Untested

When the sandbox's package manager would refuse a selected target under the Repository's Minimum release age, the Upgrade SHALL end as Untested with that reason before the Baseline, an Install Check or an Agent Attempt runs. The detail SHALL name the setting, the release's publish time and when the target becomes eligible.

#### Scenario: Menu assumed a shorter age

- **WHEN** the Upgrade menu offered a release published two days ago and the package manager in the sandbox requires three days
- **THEN** the Inspection Report records the Upgrade as Untested for the Minimum release age and no model request is made

#### Scenario: Target is old enough

- **WHEN** the selected release is older than the package manager's Minimum release age
- **THEN** the Baseline and the checks run as before
