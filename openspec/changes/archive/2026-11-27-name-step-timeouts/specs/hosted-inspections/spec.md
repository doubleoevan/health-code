## MODIFIED Requirements

### Requirement: Resolve the cache before charging a visitor

The site SHALL reuse a conclusive report for the same public repository, commit, library version and hosted deployment commit, including confirmed upgrade failures. Incomplete discovery, an unusable baseline, a stopped inspection or an Untested upgrade SHALL allow a fresh submission under the usual limits. A new deployment commit SHALL start a fresh cache and preserve existing report URLs.

#### Scenario: Verify a public checkout

- **WHEN** the site looks up a cached result
- **THEN** it verifies public visibility and the resolved head. On a miss it checks repository size before allocating a sandbox and publishes under the inspected SHA only.

#### Scenario: Retry after sandbox loss

- **WHEN** an inspection loses its sandbox
- **THEN** the report distinguishes completed checks, interrupted work and selected upgrades that never started. A retry measures a fresh baseline and may reuse conclusive results from the same repository, commit, library and deployment for the exact workspace versions and target. Each reused upgrade links to its original report.

#### Scenario: Retry after a timed-out report

- **WHEN** a visitor resubmits a repository whose report has a Baseline install that reached its check limit, or stopped at the inspection limit
- **THEN** the site starts a new inspection and keeps the earlier report readable

#### Scenario: Cached result at the cap

- **WHEN** a visitor at the daily or personal limit submits the same public repository at an already conclusively inspected head, library version and deployed revision
- **THEN** the existing report URL is returned immediately after lookup, without a challenge, new Inspection, quota debit, spend reservation or queue entry

#### Scenario: Race during lookup

- **WHEN** simultaneous submissions resolve the same uncached key and the default branch moves afterwards
- **THEN** at most one worker inspects the resolved SHA, both submissions receive its ID, and the later commit has a separate cache identity

#### Scenario: Metadata unavailable or over limit

- **WHEN** visibility or size cannot be established, or a cache miss exceeds the configured size
- **THEN** admission explains the result and creates no paid work or visitor debit
