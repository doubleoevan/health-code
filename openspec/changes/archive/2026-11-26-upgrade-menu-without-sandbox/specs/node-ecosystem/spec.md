# Spec Delta

## ADDED Requirements

### Requirement: Read the locked dependencies through one implementation

The Guest and the Upgrade menu SHALL derive the package manager, the declared workspaces, the locked version of each direct dependency per workspace and the skipped dependencies from the same implementation, which takes file contents as input. They SHALL share the registry lookup and the version selection the same way.

#### Scenario: Parity on recorded projects

- **WHEN** the recorded npm, pnpm, Bun, Yarn and modern Yarn fixture projects are read once as a checkout and once as GitHub responses
- **THEN** both readings return the same locked versions per workspace and the same skipped dependencies

#### Scenario: Binary Bun lockfile

- **WHEN** the recorded binary Bun fixture is read both ways
- **THEN** the checkout reading returns its locked versions and the GitHub reading returns the binary lockfile reason

#### Scenario: Skip the dated lookup for an unmodified package

- **WHEN** a Minimum release age applies and a package's registry record was last modified before the age window
- **THEN** the lookup returns that package's newest stable versions without requesting publish dates

### Requirement: Read the declared package manager version from committed files

The shared implementation SHALL read the package manager version a Repository declares from the root manifest's `packageManager`, `devEngines.packageManager` and `engines` fields and, for Bun, from `.bun-version`, in that order. Only an exact version SHALL count as a declared version. A version declared for a different package manager than the lockfile selects SHALL be ignored.

#### Scenario: Bun version file

- **WHEN** a Bun project commits `.bun-version` containing 1.4.4 and its manifest declares no version
- **THEN** the declared version is Bun 1.4.4 from `.bun-version`

#### Scenario: A range

- **WHEN** `engines` requires pnpm 9 or later and nothing else declares a version
- **THEN** the project has no declared version

#### Scenario: Two sources

- **WHEN** `packageManager` and `.bun-version` name different versions
- **THEN** the declared version is the `packageManager` version
