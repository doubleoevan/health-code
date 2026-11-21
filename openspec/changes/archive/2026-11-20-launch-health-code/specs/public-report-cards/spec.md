## ADDED Requirements

### Requirement: Display the prompts used

The completed public Report Card SHALL show effective model prompt names and versions and distinguish a generated Patch handoff. Previously persisted cards lacking provenance SHALL remain readable.

#### Scenario: Known empty versus legacy evidence

- **WHEN** a new card records no model calls
- **THEN** the page explains that no model prompts were used, while a legacy card without this field says prompt versions are unavailable

### Requirement: Offer a useful next step at the daily limit

The public home and admission response SHALL explain when new paid Inspections are paused for the daily budget, show the UTC reset and link to the personally funded MCP setup. The existing report and Patch URLs SHALL remain available.

#### Scenario: Share a card during a pause

- **WHEN** a visitor opens a shared card while daily paid admission is paused
- **THEN** the report, its evidence, the Patch handoff and the MCP setup destination remain accessible
