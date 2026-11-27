# inspection-evaluations Specification

## Purpose
Measure how the inspection engine handles real upgrades and Baselines at fixed commits against independently recorded answers.

## Requirements

### Requirement: Reproduce and score cases at fixed commits

The evaluation runner SHALL accept versioned cases with repository, full commit, exact upgrade or Baseline-only mode, expected checks, expected Verdicts, failure criteria and an optional reference patch. It SHALL execute the same engine phases as consumers and keep grading data separate from model inputs. Each report SHALL give case pass/fail, outcome, existing test changes, dependency reviews, source diff against the reference where available, cost and elapsed time.

#### Scenario: A later dependency version exists

- **WHEN** a newer registry version becomes available
- **THEN** the case still checks the exact recorded versions at the case's commit, and compares source changes with the recorded reference independently of patch metadata.

#### Scenario: Running preflight

- **WHEN** a developer runs preflight without credentials
- **THEN** no hosted sandbox or model is called. Live evaluations are available through an explicit manual command or a manually dispatched report-only workflow.

### Requirement: Grade the TypeScript boundary failure

The TypeScript seed SHALL inspect 5.9.3 to 7.0.2 at Health Code commit 7e6d81920e7959933822dc628fe7ad184f56cf61. It SHALL require a confirmed failed Upgrade Check and a named locator in scripts/readWorkspace.ts. The preferred result is Fixed with green tests and unchanged existing cases. A Can't fix diagnosis is acceptable only with the expected removed TypeScript APIs, supporting evidence and no patch. The reference is f89eebc05313cb8e49e1d81934ac2484f640cb92.

#### Scenario: A working repair differs from the reference

- **WHEN** the fix resolves the removed config/parser use, adds tests and includes any new dependencies in flagged commits
- **THEN** the evaluation can pass and shows the source diff and dependency reviews.

#### Scenario: Verify the default repair budget

- **WHEN** the TypeScript case uses public version 2 defaults with no overrides
- **THEN** the budget acceptance check requires Fixed within all ceilings, a green final check and unchanged existing tests. The grader checks observed turns, attempt and inspection durations, metered or reserved costs, and the 8,192-output-token ceiling for each agent reply. It includes the sandbox cost bound in the inspection total. An acceptable diagnosis alone leaves this check unmet.

#### Scenario: A false green result

- **WHEN** the case reports Passes as is, weakens an existing test, or publishes an unflagged new dependency
- **THEN** the evaluation fails even if the final command exited successfully.

### Requirement: Grade linked dependency and mocked path repairs

The linked-dependencies, matching-versions and mocked-import-path cases SHALL inspect commit a20b925b740b8e3ab1f639b53e3adc1e913f39fb and require a confirmed failed Upgrade Check, green tests and the public default budgets. The @vitejs/plugin-react 5.2.0 to 6.3.0 case SHALL require Fixed with unchanged existing tests and an upgraded vite. The react 19.2.8 to 19.3.1 case SHALL require Fixed with unchanged existing tests and an upgraded react-dom. The @novnc/novnc 1.5.0 to 1.7.0 case SHALL require Fixed with test changes.

#### Scenario: A linked dependency is missing

- **WHEN** a repair of the linked-dependencies case leaves vite at its installed version or a repair of the matching-versions case leaves react-dom at its installed version
- **THEN** the evaluation fails.

#### Scenario: A repair has an unexpected Verdict

- **WHEN** the Verdict or the presence of existing test changes differs from the case
- **THEN** the evaluation fails.

### Requirement: Grade a credential-free Baseline

The Baseline seed SHALL inspect commit 2c229c8d44e957e93d5178a8664d5e2d5cbbe0f6 with zero upgrades, no application keys in the guest and no model calls. Its first record-mode execution SHALL write measured test counts and test file errors with file paths and reasons to the case file for review. Scoring SHALL require reviewed expectations and leave the case file unchanged.

#### Scenario: Record the first Baseline

- **WHEN** a developer invokes `bun run eval --case baseline-test-counts --record` and the Baseline inventory and cleanup complete
- **THEN** the runner atomically writes passed, failed, skipped and todo counts and the sorted list of test file errors with their paths and reasons into that case. It marks the measurements pending review and issues no passing score.

#### Scenario: Recording fails before the inventory is complete

- **WHEN** checkout resolves to another SHA, observation is incomplete or cleanup fails
- **THEN** record mode reports the failure and preserves the previous case file.

#### Scenario: A test file cannot load

- **WHEN** the Baseline passes the expected cases and a known file fails before case discovery
- **THEN** the Baseline records the file and the reason in `testFileErrors`, the comparison records the exact passing count, and the case reports Verdict and reference patch as inapplicable.

#### Scenario: A test file error disappears from reporting

- **WHEN** the passing count looks plausible but a known load failure is missing or misclassified
- **THEN** scoring fails and reports the inventory difference against the reviewed case without changing expectations.

#### Scenario: A reviewed measurement uses the earlier test inventory field

- **WHEN** the evaluator reads a saved measurement with `exclusions`
- **THEN** it compares the same file paths and reasons as `testFileErrors`. New case files use `testFileErrors`. A test file error belongs to a file and stays separate from a named case failure or a skipped case.

### Requirement: Preserve effective prompt identities in evaluation output

Evaluation output SHALL include the identities, versions and digests of the prompts used by the evaluated Inspection, including caller overrides. The evaluation SHALL distinguish an empty call list from unavailable provenance.

#### Scenario: Compare two evaluations

- **WHEN** repeated evaluations use different effective revisions of one prompt
- **THEN** the output identifies which prompt changed and agrees with each Inspection’s own report
