# public-inspection-reports Specification

## Purpose
Give a shared link a durable record of what Health Code inspected, what Runta enforced and which tested Patches a visitor can apply.

## Requirements

### Requirement: Durable, readable evidence

Each stable Inspection Report URL SHALL show a summary, Repository, inspected commit, Baseline under “Checks before the upgrade”, and one card per Upgrade. Each card SHALL show the dependency, source and target versions, textual Verdict, plain-language changes, Code Feature Matches, Install Check findings, typecheck and deprecation evidence, size difference and available Patches. The report SHALL link supplied GitHub permalinks and identify missing evidence.

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

The server SHALL deliver the report content, canonical URL, Open Graph title, URL and description, and Twitter summary card metadata in the first HTML response. The page header SHALL offer one secondary “Copy report link” button.

#### Scenario: A crawler opens the shared link

- **WHEN** a client requests a completed Inspection Report with JavaScript disabled
- **THEN** it receives the report and text preview naming the outcome, the tested Patch count or the reason there is none, and any confirmed install block count

#### Scenario: Copy the report link

- **WHEN** the visitor selects Copy report link
- **THEN** the canonical URL is copied and the page confirms it, or the URL is shown as selectable text when copying is unavailable

### Requirement: Immutable Patch delivery

The site SHALL publish tested Patches for public Repositories when GitHub detects any OSI-approved license at the inspected commit, including copyleft licenses. Each published Patch SHALL have a permanent URL containing the SHA-256 digest of its exact bytes. When a published Patch is available, the primary “Upgrade prompt for your coding agent” box SHALL compose the library’s agent prompt with the Patch URL, digest, base commit, application order and directions to verify each digest before applying.

#### Scenario: Download and verify

- **WHEN** a visitor opens a published Patch URL after a redeployment
- **THEN** it returns the same bytes, and the copied prompt instructs the agent to stop on a digest mismatch and apply the Upgrade Patch before its dependent feature Patch

#### Scenario: Copyleft at the inspected commit

- **WHEN** GitHub detects an OSI-approved AGPL, GPL or MPL license at the inspected commit and a tested Patch exists
- **THEN** the report publishes the Patch and offers “Upgrade prompt for your coding agent” even if the default branch now has a different license

#### Scenario: Findings-only publication

- **WHEN** GitHub detects no OSI-approved license or its detection is ambiguous or unavailable at the inspected commit
- **THEN** the report explains why only findings are published and exposes no Patch bytes, Patch URLs or application prompts through any public surface

#### Scenario: Live output from a licensed repository

- **WHEN** an inspection starts at a known commit and GitHub detects an OSI-approved license there
- **THEN** the live log offers raw command output before the report completes. Output stays withheld otherwise. The completed report keeps that license and looks it up again only when it was not verified at the start.

#### Scenario: Failed inspection of a licensed repository

- **WHEN** an inspection fails after GitHub detected an OSI-approved license at its inspected commit
- **THEN** its recorded raw command output stays available

#### Scenario: An inspection stops early without a tested patch

- **WHEN** checks stop early and the report contains no published Patch
- **THEN** the primary “Troubleshooting prompt for your coding agent” box includes available check results and the Inspection Report URL for the downstream agent

### Requirement: Continue in a coding agent

The page header SHALL link to Health Code CI setup and real Runta signup. Any displayed Health Code account or paid tier SHALL carry an explicit mocked label.

#### Scenario: Continue from a report

- **WHEN** a visitor opens a report
- **THEN** they see setup and signup destinations
- **AND** when the report has a published Patch, “Upgrade prompt for your coding agent” supports direct Patch retrieval

### Requirement: Keep internal run settings off the report page

The saved Inspection Report SHALL record effective model prompt names and versions. The public report page SHALL omit prompt versions, turn limits and the usage measurement time. Previously persisted reports lacking provenance SHALL remain readable.

#### Scenario: Read a report with recorded settings

- **WHEN** a saved report records prompt versions, turn limits and a usage measurement time
- **THEN** the page shows the inspection details without them

### Requirement: Offer a useful next step at the daily limit

The public home and admission response SHALL explain when new paid Inspections are paused for the daily budget, show the UTC reset and link to the personally funded CI setup. The existing report and Patch URLs SHALL remain available.

#### Scenario: Share a report during a pause

- **WHEN** a visitor opens a shared report while daily paid admission is paused
- **THEN** the report, its evidence, the Patch handoff and the CI setup destination remain accessible
