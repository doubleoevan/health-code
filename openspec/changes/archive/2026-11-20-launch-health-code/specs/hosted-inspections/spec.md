## MODIFIED Requirements

### Requirement: Durable background execution

The site SHALL return a durable ID before starting an admitted cache miss and enforce global concurrency. Identical in-flight requests SHALL share an ID. Other eligible work SHALL queue in FIFO order and show its one-based position live and after reconnect. Through the public library API, live Inspections SHALL receive configured limits, Claude Opus 5.5 for every model role, the Runta secret name for the model key and an optional GitHub token.

#### Scenario: Concurrent submissions

- **WHEN** three different eligible repositories are submitted with one available slot
- **THEN** each visitor receives an ID, the waiting visitors see positions one and two, and the second position advances when the first queued Inspection starts

#### Scenario: Server restarts during execution

- **WHEN** the service restarts with queued, running and completed Inspections
- **THEN** eligible queued work resumes in order, interrupted work shows its terminal explanation, and completed links stay readable

## ADDED Requirements

### Requirement: Resolve the cache before charging a visitor

The site SHALL return the existing complete report for the same public repository, commit and library version. It SHALL verify current public visibility and the resolved head before returning a cache hit. Misses SHALL check repository size before allocating a sandbox. The site SHALL publish a result under the inspected SHA only.

#### Scenario: Cached result at the cap

- **WHEN** a visitor at the daily or personal limit submits the same public repository at an already inspected head and library version
- **THEN** the existing report URL is returned immediately after lookup, without a challenge, new Inspection, quota debit, spend reservation or queue entry

#### Scenario: Race during lookup

- **WHEN** simultaneous submissions resolve the same uncached key and the default branch moves afterwards
- **THEN** at most one worker inspects the resolved SHA, both submissions receive its ID, and the later commit has a separate cache identity

#### Scenario: Metadata unavailable or over limit

- **WHEN** visibility or size cannot be established, or a cache miss exceeds the configured size
- **THEN** admission explains the result and creates no paid work or visitor debit

### Requirement: Enforce anonymous quotas and aggregate Inspection spend

The site SHALL enforce the approved challenge, daily visitor allowance, concurrency and aggregate daily model plus sandbox cost before allocating paid work. Admission SHALL reserve bounded exposure atomically and settle it once from available evidence. Partial, interrupted and cross-midnight Inspections SHALL remain accounted for. The UTC daily budget SHALL default to $10 including model and sandbox spend.

#### Scenario: Launch admission defaults

- **WHEN** the site uses its launch settings
- **THEN** each visitor can start three new Inspections per UTC day, at most two Inspections execute concurrently, and each eligible repository is at most 100 MiB with up to two upgrades

#### Scenario: Attempt and Inspection ceilings

- **WHEN** a hosted Inspection starts with the approved settings
- **THEN** its effective repair, feature adoption and total ceilings are $2, $1 and $5, and cumulative attempt and sandbox exposure fits within the total

#### Scenario: Concurrent final budget claims

- **WHEN** two distinct eligible requests compete for the last available budget
- **THEN** only work that fits receives a reservation and queue entry, and a refused visitor sees the reset and personally funded MCP option

#### Scenario: Visitor allowance is exhausted

- **WHEN** either the authenticated ingress IP digest or visitor cookie digest has reached its UTC allowance for new Inspections
- **THEN** the response explains the allowance and reset time, and refreshing or joining a report consumes no further allowance

#### Scenario: Missing cost on failure

- **WHEN** a worker exits before recording all measured costs
- **THEN** its outstanding exposure remains charged conservatively until reconciled, independently of a restart or UTC date change

### Requirement: Periodically remove overdue orphaned runtimes

The hosted deployment SHALL periodically reconcile all its runtime inventory pages and delete its orphaned runtimes older than the maximum Inspection lifetime and cleanup allowance. It SHALL preserve valid live leases and unrelated deployments and retry failed deletions.

#### Scenario: A worker disappears between startup sweeps

- **WHEN** a previously active Inspection loses its worker and a site-owned runtime exceeds its deadline
- **THEN** a scheduled sweep reclaims it without requiring another restart and preserves neighboring deployment and CLI runtimes
