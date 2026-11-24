# hosted-inspections Specification

## Purpose
Let a visitor submit a public Repository anonymously and follow the same Inspection through disconnects, reloads and completion.

## Requirements

### Requirement: Public Repository admission

The home page SHALL offer one Repository URL field, one submit button and a plain explanation that AI agents test dependency upgrades in a Runta sandbox with restricted network access, keep model keys outside and return tested Patches when available. The server SHALL accept only public GitHub HTTPS Repository URLs.

#### Scenario: Invalid input

- **WHEN** a visitor submits a non-GitHub host, a URL with credentials, or a subpage of a Repository
- **THEN** the server rejects the input before scheduling any sandbox work and shows the expected URL format

#### Scenario: Private, missing or unsupported Repository

- **WHEN** GitHub cannot confirm public visibility
- **THEN** the site explains whether the Repository is private or missing, or verification is temporarily unavailable, and does not start an Inspection

#### Scenario: Unsupported ecosystem

- **WHEN** the inspected project lacks the supported JavaScript or TypeScript project structure
- **THEN** the page explains the supported ecosystem and displays the specific detection reason where available

### Requirement: Durable background execution

The site SHALL return a durable ID before starting an admitted cache miss and enforce global concurrency. Identical in-flight requests SHALL share an ID. Other eligible work SHALL queue in FIFO order and show its one-based position live and after reconnect.

#### Scenario: Worker dispatches a selected upgrade

- **WHEN** the worker calls the public library API
- **THEN** it passes configured limits, the Runta secret name for the model key and an optional GitHub token. It reads the same model settings as the MCP and chooses no model itself. A missing model setting keeps the worker from starting. A directly configured site names the setting. A site that loads settings at runtime keeps serving reports and retries.

#### Scenario: Concurrent submissions

- **WHEN** three different eligible repositories are submitted with one available slot
- **THEN** each visitor receives an ID, the waiting visitors see positions one and two, and the second position advances when the first queued Inspection starts

#### Scenario: Server restarts during execution

- **WHEN** the service restarts with queued, running and completed Inspections
- **THEN** eligible queued work resumes in order, interrupted work shows its terminal explanation, and completed links stay readable

### Requirement: Startup recovery of site-owned runtimes

On startup the site SHALL mark every running Inspection interrupted, show that a server restart interrupted it and preserve its timeline. Before starting queued work it SHALL find runtimes by this deployment’s reserved name prefix and delete each one with no live Inspection.

#### Scenario: Restart leaves an allocation behind

- **WHEN** startup finds a runtime for an interrupted Inspection or a site-prefixed allocation with no stored Inspection
- **THEN** it deletes the orphan even if the previous process never recorded a sandbox-created event

#### Scenario: Shared runtime account

- **WHEN** the inventory contains a live Inspection’s runtime, another deployment’s runtime and CLI or MCP runtimes
- **THEN** recovery preserves all of them, even when their names share the generic Health Code prefix

#### Scenario: Repeat recovery after a partial cleanup

- **WHEN** deletion succeeded for one orphan and failed for another
- **THEN** recovery retries the remaining orphan, accepts confirmed absence as success and retains the interrupted status at the existing report URL

### Requirement: Resumable Inspection Events

The service SHALL persist each Inspection Event before delivering it and replay events in sequence after the viewer's cursor. A completed Inspection SHALL lead to a readable Inspection Report. Failures SHALL leave the recorded timeline accessible.

#### Scenario: Reconnect at the live boundary

- **WHEN** a viewer disconnects after event 4, events 5 and 6 arrive offline, and event 7 arrives during reconnection
- **THEN** the restored view contains events 1 through 7 in order, each displayed once

#### Scenario: Reload after completion

- **WHEN** a visitor reloads a completed Inspection or reconnects after its last library event
- **THEN** the visitor can reach its persisted Inspection Report without starting another Inspection

### Requirement: Stop an Inspection

The live page SHALL let the visitor who started an Inspection stop it after one confirmation while no other submission has joined it. Local sites SHALL let any visitor stop an Inspection. Leaving the page SHALL keep the Inspection running.

#### Scenario: Stop queued work

- **WHEN** the starting visitor stops a queued Inspection
- **THEN** it leaves the queue, releases its spend reservation and shows Inspection stopped at its existing URL

#### Scenario: Stop running work

- **WHEN** the starting visitor stops a running Inspection
- **THEN** the library cancels its work, deletes its sandbox and settles recorded costs. The page keeps the recorded timeline and shows Inspection stopped

#### Scenario: Joined work

- **WHEN** another submission has joined the Inspection
- **THEN** the site offers no stop control and refuses a stop request

### Requirement: Live progress and sandbox evidence

The live page SHALL update one active step in place with a spinner and elapsed time. It SHALL keep finished steps in a rolling log, put buffered output behind Show details and pin visually distinct Sandbox Events.

#### Scenario: Quiet step

- **WHEN** a command runs for several seconds without output
- **THEN** the timer advances from its recorded start until its finish event moves the step into the log

#### Scenario: Sandbox actions

- **WHEN** the library records creation, network lock, a confirmed block, credential isolation, an agent start with its model key kept outside the sandbox, or deletion
- **THEN** the viewer can find the observed action after later steps scroll away and distinguish sandbox setup from agent execution

### Requirement: Offline fixture replay

Development and test mode SHALL reproduce recorded event timing and the corresponding Inspection Report through the same public site routes without credentials or external calls. The public demo SHALL execute real Inspections.

#### Scenario: End-to-end replay

- **WHEN** a visitor submits a fixture Repository in development
- **THEN** the site shows replay status, streams at recorded intervals and publishes the matching fixture report through the normal completion path

#### Scenario: Production configuration

- **WHEN** someone requests fixture replay in the deployed demo
- **THEN** browser input cannot select it and a server configured for production replay refuses to start

### Requirement: Resolve the cache before charging a visitor

The site SHALL reuse a conclusive report for the same public repository, commit, library version and hosted deployment commit, including confirmed upgrade failures. Incomplete discovery, an unusable baseline or an Untested upgrade SHALL allow a fresh submission under the usual limits. A new deployment commit SHALL start a fresh cache and preserve existing report URLs.

#### Scenario: Verify a public checkout

- **WHEN** the site looks up a cached result
- **THEN** it verifies public visibility and the resolved head. On a miss it checks repository size before allocating a sandbox and publishes under the inspected SHA only.

#### Scenario: Retry after sandbox loss

- **WHEN** an inspection loses its sandbox
- **THEN** the report distinguishes completed checks, interrupted work and selected upgrades that never started. A retry measures a fresh baseline and may reuse conclusive results from the same repository, commit, library and deployment for the exact workspace versions and target. Each reused upgrade links to its original report.

#### Scenario: Cached result at the cap

- **WHEN** a visitor at the daily or personal limit submits the same public repository at an already conclusively inspected head, library version and deployed revision
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
- **THEN** each visitor can start five new Inspections per UTC day, at most two Inspections execute concurrently, and each eligible repository is at most 100 MiB with up to two upgrades

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

### Requirement: Browse before testing

The site SHALL discover eligible upgrade targets at one commit before installing dependencies or invoking an agent. The upgrade menu SHALL show one row per dependency, searchable by name, with the most declaring workspaces first by default. Visitors may choose alphabetical order or minor upgrades first. The Tested patch available filter SHALL appear when the menu has a published upgrade patch and SHALL show only targets with one.

#### Scenario: Choose one target

- **WHEN** a visitor selects a version from the upgrade menu
- **THEN** the site SHALL open its published patch or admit a single-target inspection at the discovered commit under the hosted limits. If the repository head has moved before admission, the site SHALL prompt the visitor to refresh the upgrade menu.

Each dependency page SHALL load version-specific release features for its visible targets without a model call. Each entry SHALL link to its release notes. Missing notes and notes with no identified feature entries SHALL have distinct messages.
