# hosted-inspections Specification

## Purpose
Let a visitor submit a public Repository anonymously and follow the same Inspection through disconnects, reloads and completion.

## Requirements

### Requirement: Public Repository admission

The home page SHALL offer one Repository URL field, one submit button and a plain explanation that AI agents test dependency upgrades in a Runta sandbox with restricted network access, keep real keys outside and return tested Patches when available. The server SHALL accept only public GitHub HTTPS Repository URLs.

#### Scenario: Invalid input

- **WHEN** a visitor submits a non-GitHub host, a URL with credentials, or a subpage of a Repository
- **THEN** the server rejects the input before scheduling any sandbox work and shows the expected URL format

#### Scenario: Private, missing or unsupported Repository

- **WHEN** GitHub cannot confirm public visibility
- **THEN** the site explains whether the Repository is private or missing, or verification is temporarily unavailable, and does not start an Inspection

#### Scenario: Unsupported ecosystem

- **WHEN** the pinned project lacks the supported JavaScript or TypeScript project structure
- **THEN** the page explains the supported ecosystem and displays the specific detection reason where available

### Requirement: Durable background execution

The site SHALL acknowledge a valid submission with an ID before executing the Inspection, enforce a configured concurrency limit and retain its progress independently of any browser. Live Inspections SHALL receive server-configured limits, Claude Opus 5.5 for every model role, the model key's Runta secret name and the optional GitHub token through the public library interface.

#### Scenario: Concurrent submissions

- **WHEN** two visitors submit valid URLs and one execution slot is available
- **THEN** both receive distinct IDs promptly, only one Inspection executes at a time, and the other shows its queued status

#### Scenario: Server restarts during execution

- **WHEN** the server restarts with queued and in-progress Inspections
- **THEN** queued work proceeds, interrupted work shows a terminal explanation at its existing URL, and completed reports remain available

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

The service SHALL persist each Inspection Event before delivering it and replay events in sequence after the viewer's cursor. A completed Inspection SHALL lead to a readable Report Card. Failures SHALL leave the recorded timeline accessible.

#### Scenario: Reconnect at the live boundary

- **WHEN** a viewer disconnects after event 4, events 5 and 6 arrive offline, and event 7 arrives during reconnection
- **THEN** the restored view contains events 1 through 7 in order, each displayed once

#### Scenario: Reload after completion

- **WHEN** a visitor reloads a completed Inspection or reconnects after its last library event
- **THEN** the visitor can reach its persisted Report Card without starting another Inspection

### Requirement: Live progress and sandbox evidence

The live page SHALL update one active step in place with a spinner and elapsed time. It SHALL keep finished steps in a rolling log, put buffered output behind Show details and pin visually distinct Sandbox Events.

#### Scenario: Quiet step

- **WHEN** a command runs for several seconds without output
- **THEN** the timer advances from its recorded start until its finish event moves the step into the log

#### Scenario: Sandbox actions

- **WHEN** the library records creation, network lock, a confirmed block, credential isolation, an agent start with its real key withheld, or deletion
- **THEN** the viewer can find the observed action after later steps scroll away and distinguish sandbox setup from agent execution

### Requirement: Offline fixture replay

Development and test mode SHALL reproduce recorded event timing and the corresponding Report Card through the same public site routes without credentials or external calls. The public demo SHALL execute real Inspections.

#### Scenario: End-to-end replay

- **WHEN** a visitor submits a fixture Repository in development
- **THEN** the site shows replay status, streams at recorded intervals and publishes the matching fixture card through the normal completion path

#### Scenario: Production configuration

- **WHEN** someone requests fixture replay in the deployed demo
- **THEN** browser input cannot select it and a server configured for production replay refuses to start
