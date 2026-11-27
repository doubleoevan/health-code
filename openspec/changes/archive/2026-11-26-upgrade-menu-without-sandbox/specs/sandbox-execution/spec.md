# Spec Delta

## ADDED Requirements

### Requirement: Install the package manager version the Repository declares

After checkout and before any Repository-controlled file executes, the sandbox SHALL install the package manager version the Repository declares, in place of the bundled one, when that version is trusted. Installs, lockfile changes and checks SHALL then run with it. A Repository with no declared version SHALL use the bundled version.

#### Scenario: Declared Bun

- **WHEN** a Repository declares Bun 1.4.4 and the bundled Bun is 1.4.3
- **THEN** the Baseline install and the Upgrade's lockfile are produced by Bun 1.4.4

#### Scenario: No declared version

- **WHEN** a Repository declares no package manager version
- **THEN** the bundled version runs, as before

#### Scenario: Provider without the operation

- **WHEN** a Sandbox Provider cannot install a package manager version
- **THEN** the bundled version runs and the Inspection Report says so

### Requirement: Trust a declared package manager version only when verified

A declared version SHALL be trusted only when it is an exact stable version inside the supported range for that package manager, the public npm registry lists it under the package manager's official package, it is not deprecated, it was published at least one day ago and the downloaded archive matches the integrity the registry records. The Repository SHALL supply only the version number, never a package name or a URL. A hash in `packageManager` SHALL also match when present.

#### Scenario: Integrity mismatch

- **WHEN** the downloaded archive does not match the registry's integrity
- **THEN** nothing from the archive executes, the bundled version runs and the Inspection Report records the reason

#### Scenario: Version outside the supported range

- **WHEN** a Repository declares a version below the supported range
- **THEN** the sandbox downloads nothing for it and the bundled version runs

#### Scenario: Fresh release

- **WHEN** the declared version was published three hours ago
- **THEN** the bundled version runs and the Inspection Report names the release's age as the reason

#### Scenario: Untrusted declared value

- **WHEN** the declared value contains a URL, a path, a package name other than the package manager's or characters outside a version number
- **THEN** it declares no version, no request is built from it and the bundled version runs

#### Scenario: Download fails

- **WHEN** the registry does not serve the declared version's archive inside the time bound
- **THEN** the bundled version runs and the Inspection continues
