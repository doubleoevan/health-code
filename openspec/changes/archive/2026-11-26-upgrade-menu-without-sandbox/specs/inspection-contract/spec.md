# Spec Delta

## ADDED Requirements

### Requirement: Report the package manager version that wrote the lockfile

The Inspection Report SHALL record the package manager version that ran, whether it came from the Repository's declared version or the bundled set, the declared version with the file that declares it and the reason for any fallback. Reports written before this change SHALL stay readable.

#### Scenario: Declared version installed

- **WHEN** the sandbox installed the Repository's declared versionned Bun 1.4.4
- **THEN** the report records Bun 1.4.4, the source as declared and the file that declares it

#### Scenario: Fallback

- **WHEN** the declared version was not trusted
- **THEN** the report records the bundled version that ran, the declared version and the reason

#### Scenario: Older report

- **WHEN** a consumer reads a report that has only the package manager's name and version
- **THEN** it reads without error and shows no source
