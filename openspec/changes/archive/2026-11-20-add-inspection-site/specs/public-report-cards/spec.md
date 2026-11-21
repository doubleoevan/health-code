# Public Report Cards

## Purpose

Give a shared link a durable record of what Health Code inspected, what Runta enforced and which tested Patches a visitor can apply.

## ADDED Requirements

### Requirement: Durable, readable evidence

A stable Report Card URL SHALL render a one-line summary, the Repository and pinned commit, Baseline under “Checks before the upgrade”, and one card per inspected Upgrade. Each card SHALL identify the dependency, all source versions, target, textual Verdict, plain-language changes, Feature Matches, Install Check findings, typecheck and deprecation evidence, size difference and available Patches. Evidence links SHALL use GitHub permalinks where supplied. Missing evidence SHALL be visible.

#### Scenario: Every Verdict and sparse evidence

- **WHEN** the card records Passes as is, Fixed, Fixed with test changes, Can't fix or Untested
- **THEN** the page shows the corresponding words and color, with the reason or test changes when supplied, and preserves unavailable measurements as unknown

#### Scenario: Review an Inspection on a phone

- **WHEN** a visitor opens a report in either light or dark mode at a phone viewport
- **THEN** each Upgrade is readable, followed by the complete ordered timeline with pinned Sandbox Events and expandable raw details

#### Scenario: Incomplete recording of install activity

- **WHEN** the library reports one confirmed blocked install connection and one attempted connection with unknown outcome
- **THEN** the summary counts one confirmed block, and the Upgrade lists both findings, says “Some install activity could not be recorded.” and gives the reason when available

#### Scenario: No installation findings

- **WHEN** the install recording is complete and contains no findings
- **THEN** the Upgrade shows “No findings.” An incomplete recording with an empty list shows the incomplete-recording message.

### Requirement: Shareable report HTML

The server SHALL deliver the report content, canonical URL, Open Graph title, URL and description, and Twitter summary card metadata in the first HTML response. The summary SHALL expose Copy link and Share.

#### Scenario: A crawler opens the shared link

- **WHEN** a client requests a completed Report Card with JavaScript disabled
- **THEN** it receives the report and text preview describing actual Upgrade, feature Patch and confirmed install block counts from that Inspection

#### Scenario: Share on a desktop without native sharing

- **WHEN** the visitor selects Share on an unsupported browser
- **THEN** the canonical URL is available to copy and the page confirms a successful copy

### Requirement: Immutable Patch delivery

The site SHALL publish tested Patches for public Repositories when GitHub detects any OSI-approved license at the inspected commit, including copyleft licenses. Each published Patch SHALL have a permanent URL containing the SHA-256 digest of its exact bytes. The “Copy patch instructions” button SHALL compose the library’s agent prompt with the Patch URL, digest, base commit, application order and directions to verify each digest before applying.

#### Scenario: Download and verify

- **WHEN** a visitor opens a published Patch URL after a redeployment
- **THEN** it returns the same bytes, and the copied prompt instructs the agent to stop on a digest mismatch and apply the Upgrade Patch before its dependent feature Patch

#### Scenario: Copyleft at the inspected commit

- **WHEN** GitHub detects an OSI-approved AGPL, GPL or MPL license at the inspected commit and a tested Patch exists
- **THEN** the report publishes the Patch and offers “Copy patch instructions” even if the default branch now has a different license

#### Scenario: Findings-only publication

- **WHEN** GitHub detects no OSI-approved license or its detection is ambiguous or unavailable at the inspected commit
- **THEN** the report explains why only findings are published and exposes no Patch bytes, Patch URLs or application prompts through any public surface

### Requirement: Continue in a coding agent

The report SHALL provide a next step for Claude Code or Codex, with links to Health Code MCP setup and real Runta signup. Any displayed Health Code account or paid tier SHALL carry an explicit mocked label.

#### Scenario: Continue with or without MCP

- **WHEN** a visitor opens the next step
- **THEN** they see setup and signup destinations, and “Copy patch instructions” supports direct Patch retrieval with an MCP alternative when its retrieval tool is available
