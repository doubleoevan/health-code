## ADDED Requirements

### Requirement: Preserve effective prompt identities in evaluation output

Evaluation output SHALL include the identities, versions and digests of the prompts used by the evaluated Inspection, including caller overrides. The evaluation SHALL distinguish an empty call list from unavailable provenance.

#### Scenario: Compare two evaluations

- **WHEN** repeated evaluations use different effective revisions of one prompt
- **THEN** the output identifies which prompt changed and agrees with each Inspection’s own report
