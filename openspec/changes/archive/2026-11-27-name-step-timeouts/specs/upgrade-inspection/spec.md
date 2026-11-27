## ADDED Requirements

### Requirement: Bound each check step by its own limit

Each install, typecheck and tests step SHALL run within its own limit inside the inspection limit. When a check step reaches its own limit first, the engine SHALL record that check as untested with the `command-timeout` reason and a detail that names the step and its limit, then continue. It SHALL NOT report that the inspection reached its time limit.

#### Scenario: Default limits

- **WHEN** the caller sets no `limits.timeouts` or `limits.maxDurationMs`
- **THEN** install and tests each get 600,000 ms, typecheck gets 120,000 ms and the inspection gets 30 minutes, or 60 minutes with models

#### Scenario: Baseline install reaches its limit

- **WHEN** the Baseline install runs past the install limit while the inspection has time left
- **THEN** the Baseline install is untested with the `command-timeout` reason and a detail such as "The install step reached its 10-minute limit.", the selected upgrades are skipped because the Baseline is unusable and the report has no stop reason

#### Scenario: Upgrade check reaches its limit

- **WHEN** an upgrade's install or tests run past their limit
- **THEN** that check is untested with the `command-timeout` reason and the inspection goes on to the next upgrade

#### Scenario: Next check waits for the sandbox

- **WHEN** a Baseline typecheck runs past its limit and the sandbox ends the command a moment later
- **THEN** the typecheck is untested, the tests start only after the sandbox ends the command and the inspection does not stop with a busy sandbox

#### Scenario: Inspection limit ends a step

- **WHEN** the inspection limit ends a step before the step's own limit
- **THEN** the inspection stops with "The inspection reached its time limit." and keeps its partial report as before
