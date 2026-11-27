# Spec Delta

## Purpose

Build the Upgrade menu for a public Repository commit from GitHub and the public npm registry in the caller's process, so that listing upgrades needs no sandbox, no Runta account and no model.

## ADDED Requirements

### Requirement: Build the Upgrade menu without a sandbox

The library SHALL build an Upgrade menu in the caller's process from GitHub's API and the public npm registry. It SHALL use no Sandbox Provider, sandbox credential or model. It SHALL NOT clone the Repository, execute Repository code or run a package manager.

#### Scenario: No sandbox credential

- **WHEN** a caller lists upgrades with `RUNTA_TOKEN` unset
- **THEN** the call returns the Upgrade menu

#### Scenario: A provider is supplied

- **WHEN** a caller passes a Sandbox Provider whose every operation fails
- **THEN** the call returns the same Upgrade menu and invokes none of the provider's operations

### Requirement: Keep the menu's meaning

The Upgrade menu SHALL identify the inspected commit and list stable minor and major targets that advance every declaring workspace. It SHALL exclude deprecated releases, honor the Minimum release age and list unsupported or unresolved dependency sources as skipped. A partial registry lookup SHALL return the targets found with an issue that says what was not listed.

#### Scenario: Same answer as the sandbox listing

- **WHEN** the menu and the sandbox listing read the same commit of a public fixture
- **THEN** both return the same eligible targets and the same skipped dependencies

#### Scenario: Partial registry lookup

- **WHEN** the registry answers for 180 of 200 direct dependencies before the time bound
- **THEN** the menu lists the targets for the 180 and its issue says that 20 of 200 dependencies are missing

#### Scenario: Caller-supplied revision

- **WHEN** the caller supplies a full commit SHA
- **THEN** the menu reads that commit and reports it as the inspected commit

### Requirement: Read GitHub within a stated request budget

The menu SHALL resolve the commit, read the file tree at that commit and read only the root manifest, the workspace manifests, the lockfile and the package manager config files that declare workspaces, the Minimum release age or the package manager version. The number of GitHub requests SHALL be at most five plus the number of workspace manifests plus the number of those config files.

#### Scenario: A large workspace

- **WHEN** a Repository has about 200 direct dependencies in 15 workspaces
- **THEN** the menu makes at most 22 GitHub requests and at most one registry lookup per dependency, plus one dated lookup for each package modified inside the age window

#### Scenario: Release features are not read

- **WHEN** a menu is built
- **THEN** it makes no request for release notes, and callers read release features for the choices they show

### Requirement: Report GitHub outcomes with typed errors

A private or missing Repository, an unknown revision, a rejected token, a GitHub rate limit and an unavailable API SHALL each produce a typed error whose message says what to do next. A rate limit error SHALL carry the time the limit resets. The menu SHALL NOT retry a rate-limited request.

#### Scenario: Anonymous limit

- **WHEN** GitHub's limit for requests without a token is used up
- **THEN** the error names the reset time and says to supply a GitHub token or try again then

#### Scenario: Not enough requests left

- **WHEN** the requests remaining are fewer than the workspace manifest, lockfile and config reads the menu needs
- **THEN** the menu fails with the rate limit error before it requests any of them, having read only the root manifest and the workspace declaration

#### Scenario: Private Repository with a token

- **WHEN** the supplied token can read a private Repository
- **THEN** the menu fails with the unavailable-Repository error and reads no file from it

#### Scenario: Unknown revision

- **WHEN** the supplied commit SHA does not exist in the Repository
- **THEN** the error says the revision was not found and to check the commit

#### Scenario: Renamed Repository

- **WHEN** GitHub redirects the Repository's API path to its new location
- **THEN** the menu follows the redirect within GitHub's API origin and returns the menu

### Requirement: Bound every input

The menu SHALL bound the tree response, the number of tree entries and workspace manifests, each file, the total bytes read, each registry response and the total time. Callers SHALL be able to lower the bounds. A message for an exceeded bound SHALL name the bound and the observed value.

#### Scenario: Oversized file

- **WHEN** the lockfile is larger than its bound
- **THEN** the menu reads no more than the bound and returns the limit reason

#### Scenario: Time bound during the registry lookup

- **WHEN** the total time bound passes while registry lookups are in flight
- **THEN** the menu returns the targets from completed lookups with an issue

#### Scenario: Time bound while reading GitHub

- **WHEN** the GitHub reads exceed their time bound
- **THEN** the call fails with the deadline error

### Requirement: Return a typed reason for a repository the menu cannot read

When a project cannot be read without executing something or exceeds a bound, the menu SHALL return a typed reason and a message, with no targets, and SHALL NOT allocate a sandbox. The reasons SHALL distinguish a binary lockfile, a tree GitHub truncated, a symbolic link in place of a required root file and an exceeded bound.

#### Scenario: Binary Bun lockfile

- **WHEN** the only Bun lockfile at the commit is `bun.lockb`
- **THEN** the menu returns the binary lockfile reason and says a text lockfile or a sandbox listing is needed

#### Scenario: Truncated tree

- **WHEN** GitHub marks the file tree as truncated
- **THEN** the menu returns the truncated tree reason

#### Scenario: Symbolic link

- **WHEN** the root lockfile is a symbolic link
- **THEN** the menu returns the symbolic link reason and reads nothing through the link

#### Scenario: Unsupported project

- **WHEN** the commit has no supported lockfile or has competing lockfiles
- **THEN** the menu reports the detection reason the sandbox listing reports and no unreadable reason

### Requirement: Treat Repository and registry content as untrusted

The menu SHALL parse the tree listing, every file and every registry response as untrusted data. Repository content SHALL NOT choose a request URL. Requests SHALL go only to GitHub's API origin and `registry.npmjs.org`. The GitHub token SHALL be sent to GitHub's API origin only. Tokens SHALL NOT appear in errors, events or logs.

#### Scenario: Registry override in the Repository

- **WHEN** the Repository's config names another registry or carries a credential
- **THEN** the menu queries `registry.npmjs.org` only and reads no credential

#### Scenario: Redirect off the API origin

- **WHEN** a GitHub response redirects to another origin, or a registry response redirects anywhere
- **THEN** the menu does not follow it and sends no token

#### Scenario: Hostile names

- **WHEN** a manifest or lockfile uses `__proto__` or `constructor` as a dependency name, workspace path or key
- **THEN** the dependency is listed as skipped or ignored and no shared object changes

#### Scenario: Hostile structure

- **WHEN** a file nests deeply enough to overflow a parser, expands aliases or carries a pattern that is slow to match
- **THEN** the menu ends inside its time bound with a reason and the caller's process keeps running

#### Scenario: Crowded manifests

- **WHEN** the manifests declare more than 10,000 dependencies together, or a dependency name is longer than the registry allows
- **THEN** the menu reports the project as unsupported, or lists the name by its first characters, and the skipped list stays bounded

#### Scenario: Symbolic links and submodules among workspaces

- **WHEN** a workspace pattern matches a directory that is a symbolic link or a submodule
- **THEN** the menu reads no manifest from it

### Requirement: Derive the Minimum release age from committed configuration

The menu SHALL derive the Minimum release age from the committed package manager config files and the package manager version the sandbox would run, and SHALL report the value, its exempt packages and its source. When it cannot determine the setting it SHALL assume one day, or a larger value it could read, and SHALL say that the value is assumed.

#### Scenario: Explicit setting

- **WHEN** `pnpm-workspace.yaml` sets a three-day minimum release age and the newest minor release was published today
- **THEN** the menu offers the newest release that is at least three days old

#### Scenario: Default of the declared version

- **WHEN** a Repository declares pnpm 11 and sets no minimum release age
- **THEN** the menu applies pnpm 11's one-day default

#### Scenario: Setting unsupported by the version

- **WHEN** the Yarn version the sandbox would run predates the age setting
- **THEN** the menu applies no minimum release age

#### Scenario: Unknown setting

- **WHEN** two committed sources give different ages
- **THEN** the menu applies the larger of one day and the values it read, and reports the age as assumed with the cause

### Requirement: Emit Inspection Events without Sandbox Events

The menu SHALL deliver version 1 Inspection Events for its start, its commit, project and registry steps and its finish or failure through the caller's event callback. It SHALL NOT emit a Sandbox Event.

#### Scenario: An existing rolling log

- **WHEN** a caller renders a menu's events with a handler written for the sandbox listing
- **THEN** the project and registry steps display under the same labels and no sandbox line appears

#### Scenario: Failure

- **WHEN** the menu fails with a typed error after its start event
- **THEN** the last event is the failure event with the error's code
