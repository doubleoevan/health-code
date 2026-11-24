## MODIFIED Requirements

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
- **THEN** the engine may start one replacement under the original time and spend limits, pin the same commit, lock the network, measure its baseline again and finish outstanding upgrades serially. Untouched upgrades precede the interrupted target. A partial report retains completed evidence and lists selected upgrades that never started

#### Scenario: Known Baseline failures

- **WHEN** the Baseline has named failing tests or file-load failures
- **THEN** the Inspection Report retains their identities and excludes those failures when comparing the upgraded project

#### Scenario: Known Baseline type errors

- **WHEN** the Baseline typecheck reports only identified errors and the upgraded project reports the same errors
- **THEN** the Upgrade Check excludes them and runs its tests. A new error is confirmed and can be repaired
