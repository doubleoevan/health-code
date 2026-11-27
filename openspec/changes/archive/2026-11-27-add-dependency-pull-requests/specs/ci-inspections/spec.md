# Spec Delta

## ADDED Requirements

### Requirement: Read the upgrade a pull request holds

`health-code target <pull-request-url>` SHALL read the manifests and the lockfile at the pull request's base commit and at its head through GitHub's API and print one JSON object. The object SHALL name the dependency, the version the head installs, the base commit, whether the upgrade counts as a major and the packages that moved with it, or one reason from a fixed list. The command SHALL exit zero for a target and for a reason and nonzero when GitHub cannot be read.

#### Scenario: One package

- **WHEN** a Renovate pull request moves `left-pad` from 1.2.0 to 1.3.0 in a pnpm repository
- **THEN** the output names `left-pad`, 1.3.0, 1.2.0 and the base commit, with `isMajor` false and no moved packages

#### Scenario: Each package manager

- **WHEN** the same single upgrade is read from an npm, a pnpm, a Yarn and a Bun repository
- **THEN** each output names the same dependency and versions

#### Scenario: One package in several workspaces

- **WHEN** three workspaces declare the package and the head moves all three to one version
- **THEN** the output names one target at that version

#### Scenario: Workspaces end on different versions

- **WHEN** the head leaves the package on different versions across workspaces
- **THEN** the output gives the reason `mixed-versions`

#### Scenario: A lockfile-only change

- **WHEN** no manifest changed and the lockfile moves one direct dependency
- **THEN** the output names that dependency and the version the head locks

#### Scenario: Only transitive packages moved

- **WHEN** the lockfile changed and no direct dependency's locked version did
- **THEN** the output gives the reason `no-direct-dependency`

#### Scenario: An action or image bump

- **WHEN** the pull request changes no manifest and no lockfile
- **THEN** the output gives the reason `no-npm-dependency`

#### Scenario: A downgrade or a removal

- **WHEN** the head locks a lower version or drops the dependency
- **THEN** the output gives the reason `not-an-upgrade`

#### Scenario: GitHub is unavailable

- **WHEN** GitHub's request limit is used up or the pull request does not exist
- **THEN** the command prints the cause and a next step and exits nonzero

### Requirement: Name a major and a Package family

The target command SHALL count a major upgrade, and a minor upgrade from a version below 1.0, as a major. It SHALL treat several moved packages as one Package family when they share one npm scope or all move to the same version, name one of them as the target and list the others as moved with it. Any other set of several packages SHALL give the reason `grouped`.

#### Scenario: A major

- **WHEN** the head moves a package from 18.3.1 to 19.0.0
- **THEN** `isMajor` is true

#### Scenario: A minor below 1.0

- **WHEN** the head moves a package from 0.4.2 to 0.5.0
- **THEN** `isMajor` is true

#### Scenario: A patch below 1.0

- **WHEN** the head moves a package from 0.4.2 to 0.4.3
- **THEN** `isMajor` is false

#### Scenario: A family

- **WHEN** the head moves `react` and `react-dom` to 19.0.0
- **THEN** the output names `react` as the target and lists `react-dom` as moved with it

#### Scenario: A grouped pull request

- **WHEN** the head moves six packages with different scopes and versions
- **THEN** the output gives the reason `grouped` and the number of packages

### Requirement: Recognize a dependency pull request by its content

The target command SHALL answer a pull request whose head branch is in the base repository and whose changed files are only package manifests, lockfiles and the package manager's own files. It SHALL NOT read the author, the branch name or the title to decide. A pull request from a branch Health Code pushed SHALL give the reason `own-pull-request`.

#### Scenario: Renovate, Dependabot and a person

- **WHEN** Renovate, Dependabot or a person opens a pull request from a branch of the repository that changes only `package.json` and the lockfile
- **THEN** the command reads the target for each and prints the author's login

#### Scenario: A fork's branch named like a bot's

- **WHEN** a fork's pull request comes from a branch named `renovate/react-19.x`
- **THEN** the output gives the reason `fork`

#### Scenario: Other files changed

- **WHEN** the pull request moves one dependency and also changes a source file
- **THEN** the output gives the reason `other-changes`

#### Scenario: Yarn's own files

- **WHEN** the pull request changes `package.json`, `yarn.lock` and files under `.yarn/`
- **THEN** the command reads the target

#### Scenario: More changed files than GitHub lists

- **WHEN** the comparison lists 300 changed files
- **THEN** the output gives the reason `other-changes`

### Requirement: Read a pull request without executing it

The target command SHALL make no checkout, allocate no sandbox and execute nothing from the pull request. It SHALL send requests to GitHub's API origin only, within the byte and request bounds of the Upgrade menu, and treat every file, name and version as untrusted. It SHALL print a package name or a version only when it passes npm's grammar. A Repository the API cannot serve SHALL give the reason `unreadable`.

#### Scenario: An oversized or binary lockfile

- **WHEN** the head's lockfile is binary or past the byte limit
- **THEN** the output gives the reason `unreadable` and the command reads no further

#### Scenario: A crafted name

- **WHEN** a manifest at the head declares a dependency whose name fails npm's grammar
- **THEN** the name appears nowhere in the output

#### Scenario: No model and no account

- **WHEN** the command runs without `RUNTA_TOKEN` and without model settings
- **THEN** it reads the target, since it needs neither
