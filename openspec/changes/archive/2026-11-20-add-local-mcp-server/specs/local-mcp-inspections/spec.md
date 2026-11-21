# Local MCP inspections

## Purpose

Give coding agents a local interface for inspecting public Repositories on the developer’s account and applying the resulting tested Patches.

## ADDED Requirements

### Requirement: Connect personal accounts once

The existing unscoped `health-code` npm package SHALL start the Node stdio server with `npx health-code mcp`. The command `npx health-code mcp setup` SHALL check access using `RUNTA_TOKEN`, read the model key from the environment, store it through the Runta SDK and print exact credential-free Claude Code and Codex stdio configuration on success.

#### Scenario: Install one release

- **WHEN** a developer installs the packed `health-code` release in a fresh Node project
- **THEN** the public package entry exports the inspection library and `npx health-code mcp` serves the four tools
- **AND** setup prints Claude Code and Codex configurations that invoke `npx -y health-code@<installed-version> mcp`

#### Scenario: First setup and key rotation

- **WHEN** setup receives valid credentials directly or through a secret manager
- **THEN** it checks the account without starting an Inspection, writes the named secret and prints configuration referencing the token and model key by environment variable name
- **AND** repeating setup updates the same named secret for that host

#### Scenario: Setup fails

- **WHEN** an input is missing, authentication fails or the secret write fails
- **THEN** setup exits unsuccessfully with the failed step and a corrective action, prints no success configuration and discloses no credential on either output stream

### Requirement: Route personally funded inspections

The caller SHALL fund sandbox and model use. All roles SHALL default to Claude Opus 5.5 on Anthropic and accept model ID and host overrides. The MCP SHALL read the environment key for release summaries and Feature Matches. Repair and feature adoption SHALL use a host-bound secret stub. The raw key SHALL stay outside the guest, tool payloads, logs and saved evidence. Optional GitHub credentials SHALL serve release-note retrieval only.

#### Scenario: First Inspection after setup

- **WHEN** the client forwards the sandbox token and model key after setup stored the agent secret
- **THEN** summary and matching use the host key, and repair and feature adoption receive only their stored-secret reference

#### Scenario: Host key missing

- **WHEN** a live start lacks the host key
- **THEN** the server names the missing variable before dispatching paid work and still serves local saved evidence

#### Scenario: Host mismatch

- **WHEN** a new model host lacks a matching registered secret
- **THEN** agent authentication requires setup for that origin and the gateway never forwards another origin’s stored credential

### Requirement: Discover and start inspections

Both clients SHALL discover four titled tools with input and output schemas, plain summary-first text, accurate read-only and open-world hints, and usable structured success results. `start_inspection` SHALL accept a public GitHub Repository URL, return an Inspection ID immediately and continue work in the local server process.

#### Scenario: Inspect a slow repository

- **WHEN** the library emits its start event but the sandbox has yet to finish its first operation
- **THEN** the client receives the ID and polling guidance, and can issue another tool call while the Inspection proceeds

#### Scenario: Unacceptable source

- **WHEN** a caller supplies a non-GitHub URL or the public clone cannot access the Repository
- **THEN** the caller receives a readable start error or a terminal failure under the issued ID, respectively

### Requirement: Follow live and recorded evidence

`read_inspection` SHALL return status, current step, ordered rolling log and highlighted, pinned Sandbox Events. It SHALL expose the terminal Report Card or failure reason. Start and read calls SHALL send current-step progress only during a live request with a supplied progress token.

#### Scenario: Poll and resume

- **WHEN** the caller reads after the last seen sequence
- **THEN** it receives subsequent events in order, a continuation cursor and the current step, including when no new events have arrived

#### Scenario: Progress lifetime

- **WHEN** a read waits briefly for more events with a progress token
- **THEN** the client receives labeled progress during that call and receives subsequent progress through later reads
- **AND** completing or cancelling a read ends its notifications and the Inspection continues

### Requirement: Recover private Report Cards

The MCP server SHALL save completed Report Cards with their exact Patch artifacts beneath `~/.health-code/inspections/`. A fresh session SHALL read them and their recorded application results without credentials. The library SHALL remain free of storage responsibilities. Local Inspections SHALL have no public site link.

#### Scenario: Restart between inspection and adoption

- **WHEN** a second server opens an Inspection ID after the first server saved it
- **THEN** it returns the same Report Card, timeline and available Patches from disk, including for a legacy card with no Patches

#### Scenario: No recoverable record

- **WHEN** a reader supplies an unknown ID, a malformed record or an ID from an interrupted process with no saved card
- **THEN** it reports the corresponding missing or unreadable record without starting another paid Inspection

### Requirement: Deliver a tested Patch

`get_tested_patch` SHALL return the identified Patch’s exact text, SHA-256 digest, library Verdict, inspected commit, prerequisite order and library agent prompt. The handoff SHALL establish the local checkout’s relationship to the inspected commit and direct the agent to verify the digest before applying, create a branch, run typecheck and tests without editing tests, and open a pull request with the developer’s authorization.

#### Scenario: Feature adoption on a different revision

- **WHEN** the checkout is ahead, behind or diverged according to local Git history
- **THEN** the handoff identifies the relationship before edits, names each prerequisite Patch and distinguishes a locally adapted result from the tested bytes

#### Scenario: Incomplete history or missing Patch

- **WHEN** local ancestry cannot be established
- **THEN** the handoff reports the comparison as unknown and supplies the inspected base
- **AND** if the card offers no such Patch, the tool explains its absence without generating a substitute

### Requirement: Record the developer’s result

`report_patch_result` SHALL record a developer-reported application outcome, adaptation description when applicable, test status and optional pull request URL against a saved Inspection and Patch. A later read SHALL distinguish these results from the library’s original Verdict.

#### Scenario: Record or retry adoption

- **WHEN** the client reports an adapted Patch, describes the edits and supplies failed tests or a pull request URL
- **THEN** the report survives restart and displays the submitted outcome, and an identical retry produces one record

#### Scenario: Invalid result

- **WHEN** the referenced Patch is absent, an adaptation lacks a description or the pull request URL is malformed
- **THEN** the tool returns an actionable error and preserves prior results
