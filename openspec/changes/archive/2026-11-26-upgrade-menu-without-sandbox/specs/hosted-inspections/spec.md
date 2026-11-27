# Spec Delta

## MODIFIED Requirements

### Requirement: Browse before testing

The site SHALL discover eligible upgrade targets at one commit in its server, without a sandbox, before installing dependencies or invoking an agent. The upgrade menu SHALL show one row per dependency, searchable by name, with the most declaring workspaces first by default. Visitors may choose alphabetical order or minor upgrades first. The Tested patch available filter SHALL appear when the menu has a published upgrade patch and SHALL show only targets with one.

#### Scenario: Choose one target

- **WHEN** a visitor selects a version from the upgrade menu
- **THEN** the site SHALL open its published patch or admit a single-target inspection at the discovered commit under the hosted limits. If the repository head has moved before admission, the site SHALL prompt the visitor to refresh the upgrade menu.

Each dependency page SHALL load version-specific release features for its visible targets without a model call. Each entry SHALL link to its release notes. Missing notes and notes with no identified feature entries SHALL have distinct messages.

#### Scenario: Show the menu directly

- **WHEN** a visitor requests New features for a Repository with no saved menu
- **THEN** the page shows a short progress state with the menu's steps and then the menu, with no Sandbox Event, queue position or stop control

#### Scenario: A menu saved before this change

- **WHEN** a visitor opens the link of a menu that a sandbox listing produced
- **THEN** the menu opens and its targets can be selected

## ADDED Requirements

### Requirement: Build upgrade menus without paid admission

A fresh upgrade menu SHALL create no admission, spend reservation, queue entry, worker slot, challenge or sandbox, and SHALL NOT count against the visitor's daily allowance. The daily allowance and the header's count SHALL cover upgrade tests and sandbox listings only. The site SHALL build the menu at the head it resolved at submission and SHALL keep its checks and messages for private, missing and oversized repositories.

#### Scenario: Browse at the daily limit

- **WHEN** a visitor who has used the daily allowance requests New features
- **THEN** the site builds or reuses the menu and the header's count does not change

#### Scenario: Selection still pays

- **WHEN** the visitor selects a target from that menu
- **THEN** the site applies the challenge, the allowance and the spend reservation at the menu's commit

#### Scenario: Private Repository

- **WHEN** GitHub cannot confirm the Repository is public
- **THEN** the site shows today's message and builds no menu

### Requirement: Share and reuse upgrade menus

The site SHALL save each menu under an ID with a report page. It SHALL run one build per Repository, commit, library version and deployment, give simultaneous submissions the same ID and reuse a complete menu for one hour. An incomplete menu SHALL NOT be reused.

#### Scenario: Simultaneous submissions

- **WHEN** two visitors request New features for the same Repository at the same head
- **THEN** one build runs and both receive its ID

#### Scenario: Reuse within the hour

- **WHEN** a visitor requests New features 40 minutes after a complete menu was built at the same head
- **THEN** the site returns the saved menu and makes no request to list files or query the registry

#### Scenario: Incomplete menu

- **WHEN** a menu finished with a registry lookup issue
- **THEN** the next request builds a fresh menu

### Requirement: Limit fresh upgrade menus

The site SHALL limit fresh menus per visitor and per network per UTC day, cap concurrent menu builds and pause fresh menus while its remaining GitHub request quota is below a floor. Saved menus SHALL stay readable in each case. Each refusal SHALL say when to try again, except a pause the operator set, which has no end time.

#### Scenario: Visitor limit

- **WHEN** a visitor or their network has reached the daily menu limit
- **THEN** the response explains the limit and the UTC reset, and saved menus still open

#### Scenario: Quota floor

- **WHEN** the site's remaining GitHub requests, less the requests that admitted builds may still send, fall below the floor
- **THEN** fresh menus pause until GitHub's reset time before any GitHub request is sent, the response names that time and paid admission keeps its GitHub requests

#### Scenario: Repeat submission

- **WHEN** a visitor submits a Repository whose head the site resolved in the last minute and whose menu is saved
- **THEN** the site returns the saved menu without a GitHub request

#### Scenario: Busy

- **WHEN** the concurrent builds and their waiting list are full
- **THEN** the response asks the visitor to try again in a minute and creates no menu

#### Scenario: Paused by an operator

- **WHEN** an operator sets the concurrent menu builds to zero
- **THEN** fresh menus pause within the limit refresh interval, saved menus still open and the page offers the sandbox listing

### Requirement: Keep menu building off live event streams

Each menu build SHALL run in its own process with no environment variable from the server. Building the largest allowed menu SHALL NOT delay live Inspection event streams by more than one second or exhaust the server's memory. A build that passes its time bound SHALL end with a message and release its resources. A build that passes its memory limit SHALL end as a repository the menu cannot read, with the limit in its message.

#### Scenario: A stream during a build

- **WHEN** an Inspection streams events while the largest allowed menu builds
- **THEN** each event reaches the viewer within one second of its record time

#### Scenario: A build that does not finish

- **WHEN** a hostile Repository keeps a build busy past the time bound
- **THEN** the site ends the build, the page says the menu could not be built and the next menu builds normally

#### Scenario: A build that needs too much memory

- **WHEN** a build's process holds more memory than the limit the operator set
- **THEN** the site ends the process, the menu shows the limit reason and the page offers the sandbox listing

### Requirement: List a repository the menu cannot read in a sandbox

When a menu returns an unreadable reason, the page SHALL show the reason and offer to list upgrades in a sandbox. Accepting SHALL run the sandbox listing under the paid admission rules.

#### Scenario: Binary lockfile

- **WHEN** the menu reports a binary Bun lockfile
- **THEN** the page explains it and offers the sandbox listing, and nothing is debited until the visitor accepts

#### Scenario: Visitor accepts

- **WHEN** the visitor accepts the sandbox listing
- **THEN** the site applies the challenge, the allowance and the spend reservation, and shows Sandbox Events as it does today
