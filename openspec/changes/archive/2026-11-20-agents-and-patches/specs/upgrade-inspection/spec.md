# Upgrade inspection delta

## ADDED Requirements

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
- **THEN** the repair Verdict and upgrade Patch remain available and the Feature Match explains why no feature Patch was retained.

#### Scenario: A confirmed break persists at the ceiling

- **WHEN** repair reaches the time, cost or turn limit and the confirmed regression persists
- **THEN** the Verdict is Can't fix, with diagnosis and attempts and no partial Patch.
