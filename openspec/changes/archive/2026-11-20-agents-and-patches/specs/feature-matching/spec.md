# Feature matching

## Purpose

Help maintainers use new dependency features by identifying a concrete change to their own pinned code.

## ADDED Requirements

### Requirement: Read intervening releases

For each selected Upgrade the engine SHALL read package-specific releases newer than each locked source version through the target, resolve the package repository, use GitHub releases first and use the packaged CHANGELOG for gaps. The summary SHALL cite its sources, describe new features and breaking changes in plain language, and distinguish partial or missing coverage.

#### Scenario: Monorepo with two workspace versions

- **WHEN** two workspaces upgrade from different versions and some releases have no GitHub release body
- **THEN** the summary identifies applicable version ranges, deduplicates shared notes, cites fallback entries and reports uncovered versions.

#### Scenario: Release host unavailable

- **WHEN** GitHub rate limits a release request and no relevant changelog is available
- **THEN** the Report Card explains the missing evidence and the regular Upgrade Check may proceed.

### Requirement: Rank cited Feature Matches across the Inspection

The engine SHALL match a release feature to a pinned code range and identify the workaround, dependency, deprecated call or option it could replace. It SHALL rank matches deterministically, select up to the caller's inspection-wide cap and retain reasons for findings that receive no Patch.

#### Scenario: More opportunities than attempts

- **WHEN** four green upgrades each have a verified opportunity under default limits
- **THEN** the three highest-ranked opportunities receive adoption attempts, subject to budget, and the fourth retains its cited finding.

#### Scenario: A release note identifies a direct replacement

- **WHEN** a quotation in a release applicable to the pinned workspace explicitly says the new feature replaces the symbol used at the cited location
- **THEN** the match ranks as direct. A reversed, negated or unsupported replacement stays inferred.

#### Scenario: Missing code evidence

- **WHEN** a suggested feature has a release citation but the claimed export use cannot be located
- **THEN** the suggestion cannot qualify for an adoption attempt or a verified code permalink.

### Requirement: Treat release and repository text as evidence

Every model call SHALL bound and sanitize its untrusted inputs, strip delimiter-shaped text and backticks, wrap values with fresh per-call nonce delimiters, and end with trusted instructions. Model output SHALL remain untrusted when passed onward.

#### Scenario: Release text contains a forged instruction

- **WHEN** release notes or a tool result contains delimiter text, nested placeholders or instructions to edit unrelated files
- **THEN** the content remains fenced evidence, the permitted files and tools stay fixed, and unsupported output citations are rejected.
