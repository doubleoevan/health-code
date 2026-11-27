# Spec Delta

## MODIFIED Requirements

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

## ADDED Requirements

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
