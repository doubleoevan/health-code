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
- **THEN** it passes configured limits, the Runta secret name for the model key and an optional GitHub token. It reads the same model settings as the CI command and chooses no model itself. A missing model setting keeps the worker from starting. A directly configured site names the setting. A site that loads settings at runtime keeps serving reports and retries.

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

- **WHEN** the inventory contains a live Inspection’s runtime, another deployment’s runtime and CI command runtimes
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

The live page SHALL let the visitor who started an Inspection stop it with one click while no other submission has joined it. The link back to the upgrade menu SHALL appear once the Inspection ends. Local sites SHALL let any visitor stop an Inspection. Leaving the page SHALL keep the Inspection running.

#### Scenario: Stop queued work

- **WHEN** the starting visitor stops a queued Inspection
- **THEN** it leaves the queue, releases its spend reservation and shows Inspection stopped at its existing URL

#### Scenario: Stop running work

- **WHEN** the starting visitor stops a running Inspection
- **THEN** the library cancels its work, deletes its sandbox and settles recorded costs. Its URL keeps the recorded timeline and shows Inspection stopped

#### Scenario: Return to the upgrade menu

- **WHEN** an Inspection chosen from an upgrade menu is stopped
- **THEN** its open live page returns to that upgrade menu after the stop finishes

#### Scenario: Joined work

- **WHEN** another submission has joined the Inspection
- **THEN** the site offers no stop control and refuses a stop request

### Requirement: Live progress and sandbox evidence

The live page SHALL update one active step in place with a spinner and elapsed time. It SHALL keep finished steps in a rolling log, put buffered output behind Show details and list visually distinct Sandbox Events above the log.

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
- **THEN** each visitor can start ten new Inspections per UTC day, at most two Inspections execute concurrently, and each eligible repository is at most 100 MiB with up to two upgrades

#### Scenario: Attempt and Inspection ceilings

- **WHEN** a hosted Inspection starts with the approved settings
- **THEN** its effective repair, feature adoption and total ceilings are $2, $1 and $5, and cumulative attempt and sandbox exposure fits within the total

#### Scenario: Concurrent final budget claims

- **WHEN** two distinct eligible requests compete for the last available budget
- **THEN** only work that fits receives a reservation and queue entry, and a refused visitor sees the reset and personally funded CI option

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

The site SHALL discover eligible upgrade targets at one commit in its server, without a sandbox, before installing dependencies or invoking an agent. The upgrade menu SHALL show one row per dependency, searchable by name, with the most declaring workspaces first by default. Visitors may choose alphabetical order or minor upgrades first. The Tested patch available filter SHALL appear when the menu has a published upgrade patch and SHALL show only targets with one.

#### Scenario: Choose one target

- **WHEN** a visitor selects a version from the upgrade menu
- **THEN** the site SHALL open its published patch or admit a single-target inspection at the discovered commit under the hosted limits. If the repository head has moved before admission, the site SHALL prompt the visitor to refresh the upgrade menu.

Each dependency page SHALL load version-specific release features for its visible targets without a model call. Each entry SHALL link to its release notes. Missing notes and notes with no identified feature entries SHALL have distinct messages.

#### Scenario: Show the menu directly

- **WHEN** a visitor requests New features for a Repository with no saved menu
- **THEN** the page shows a short progress state with the menu's steps and then the menu, with no Sandbox Event, queue position or stop control

#### Scenario: A menu saved before this change

- **WHEN** a visitor opens the link of a menu that a sandbox listing produced
- **THEN** the menu opens and its targets can be selected

### Requirement: Build upgrade menus without paid admission

A fresh upgrade menu SHALL create no admission, spend reservation, queue entry, worker slot, challenge or sandbox, and SHALL NOT count against the visitor's daily allowance. The daily allowance and the header's count SHALL cover upgrade tests and sandbox listings only. The site SHALL build the menu at the head it resolved at submission and SHALL keep its checks and messages for private, missing and oversized repositories.

#### Scenario: Browse at the daily limit

- **WHEN** a visitor who has used the daily allowance requests New features
- **THEN** the site builds or reuses the menu and the header's count does not change

#### Scenario: Selection still pays

- **WHEN** the visitor selects a target from that menu
- **THEN** the site applies the challenge, the allowance and the spend reservation at the menu's commit

#### Scenario: Private Repository

- **WHEN** GitHub cannot confirm the Repository is public
- **THEN** the site shows today's message and builds no menu

### Requirement: Share and reuse upgrade menus

The site SHALL save each menu under an ID with a report page. It SHALL run one build per Repository, commit, library version and deployment, give simultaneous submissions the same ID and reuse a complete menu for one hour. An incomplete menu SHALL NOT be reused.

#### Scenario: Simultaneous submissions

- **WHEN** two visitors request New features for the same Repository at the same head
- **THEN** one build runs and both receive its ID

#### Scenario: Reuse within the hour

- **WHEN** a visitor requests New features 40 minutes after a complete menu was built at the same head
- **THEN** the site returns the saved menu and makes no request to list files or query the registry

#### Scenario: Incomplete menu

- **WHEN** a menu finished with a registry lookup issue
- **THEN** the next request builds a fresh menu

### Requirement: Limit fresh upgrade menus

The site SHALL limit fresh menus per visitor and per network per UTC day, cap concurrent menu builds and pause fresh menus while its remaining GitHub request quota is below a floor. Saved menus SHALL stay readable in each case. Each refusal SHALL say when to try again, except a pause the operator set, which has no end time.

#### Scenario: Visitor limit

- **WHEN** a visitor or their network has reached the daily menu limit
- **THEN** the response explains the limit and the UTC reset, and saved menus still open

#### Scenario: Quota floor

- **WHEN** the site's remaining GitHub requests, less the requests that admitted builds may still send, fall below the floor
- **THEN** fresh menus pause until GitHub's reset time before any GitHub request is sent, the response names that time and paid admission keeps its GitHub requests

#### Scenario: Repeat submission

- **WHEN** a visitor submits a Repository whose head the site resolved in the last minute and whose menu is saved
- **THEN** the site returns the saved menu without a GitHub request

#### Scenario: Busy

- **WHEN** the concurrent builds and their waiting list are full
- **THEN** the response asks the visitor to try again in a minute and creates no menu

#### Scenario: Paused by an operator

- **WHEN** an operator sets the concurrent menu builds to zero
- **THEN** fresh menus pause within the limit refresh interval, saved menus still open and the page offers the sandbox listing

### Requirement: Keep menu building off live event streams

Each menu build SHALL run in its own process with no environment variable from the server. Building the largest allowed menu SHALL NOT delay live Inspection event streams by more than one second or exhaust the server's memory. A build that passes its time bound SHALL end with a message and release its resources. A build that passes its memory limit SHALL end as a repository the menu cannot read, with the limit in its message.

#### Scenario: A stream during a build

- **WHEN** an Inspection streams events while the largest allowed menu builds
- **THEN** each event reaches the viewer within one second of its record time

#### Scenario: A build that does not finish

- **WHEN** a hostile Repository keeps a build busy past the time bound
- **THEN** the site ends the build, the page says the menu could not be built and the next menu builds normally

#### Scenario: A build that needs too much memory

- **WHEN** a build's process holds more memory than the limit the operator set
- **THEN** the site ends the process, the menu shows the limit reason and the page offers the sandbox listing

### Requirement: List a repository the menu cannot read in a sandbox

When a menu returns an unreadable reason, the page SHALL show the reason and offer to list upgrades in a sandbox. Accepting SHALL run the sandbox listing under the paid admission rules.

#### Scenario: Binary lockfile

- **WHEN** the menu reports a binary Bun lockfile
- **THEN** the page explains it and offers the sandbox listing, and nothing is debited until the visitor accepts

#### Scenario: Visitor accepts

- **WHEN** the visitor accepts the sandbox listing
- **THEN** the site applies the challenge, the allowance and the spend reservation, and shows Sandbox Events as it does today
