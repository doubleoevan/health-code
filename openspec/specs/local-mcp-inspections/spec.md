# local-mcp-inspections Specification

## Purpose
Give coding agents a local interface for inspecting public Repositories on the developer’s account and applying the resulting tested Patches.

## Requirements

### Requirement: Connect personal accounts once

The unscoped `health-code` npm package SHALL start the Node stdio server with `npx health-code mcp`. The command `npx health-code mcp setup` SHALL check account access, register or reuse the origin-bound stored secret, verify it with one bounded authenticated model request sandbox request, and confirm cleanup before printing Claude Code and Codex configuration. The client configuration SHALL include each configured model setting as a value and reference `RUNTA_TOKEN` by name. It SHALL contain no credential.

#### Scenario: Install one release

- **WHEN** a developer installs the packed release in a fresh Node project
- **THEN** the public entry exports the library, the MCP serves its inspection tools, and both printed client entries launch the installed version using the existing pinned command from the user’s home.
- **AND** both entries reference the token by name and include the configured model settings, so a later session needs only `RUNTA_TOKEN`.

#### Scenario: First setup and key rotation

- **WHEN** the user supplies a model key to setup for the selected HTTPS origin
- **THEN** it stores or rotates the same named secret, tests it through an ephemeral model request sandbox with a fixed one-output-token request, and deletes the model request sandbox. It makes no Repository checkout or Inspection and prints no key.

#### Scenario: Setup fails

- **WHEN** account access, registration, secret lookup, model request sandbox authentication or cleanup fails
- **THEN** setup exits unsuccessfully with a corrective action and any needed cleanup identifier. It prints no success configuration, request headers, model key, token value or upstream response body.

#### Scenario: Existing registration

- **WHEN** setup has the sandbox token and model settings without a key and that origin already has the expected secret
- **THEN** it verifies the stored key through the model request sandbox without downloading, replacing or requesting the key again. A missing secret produces registration instructions for that origin.

### Requirement: Route personally funded inspections

The caller SHALL fund sandbox, model request sandbox and model use. The caller SHALL configure the model host and a model ID, with optional price bounds and an optional model ID per role. Unset price bounds SHALL default to $10 per million input tokens and $50 per million output tokens. The MCP SHALL name every missing setting and the setup command in one error and choose no model itself. It SHALL support Anthropic and OpenAI-compatible hosts. The MCP SHALL select model request sandbox execution for summaries and Code Feature Matches and use the existing sandbox binding for Repair and Feature adoption. Live MCP Inspections SHALL require `RUNTA_TOKEN` and the model settings, with the key stored in Runta. An optional GitHub credential SHALL serve release retrieval only.

#### Scenario: First Inspection after setup

- **WHEN** the client supplies the sandbox token and model settings after a successful setup
- **THEN** it can complete and save an Inspection, including summaries and Code Feature Matches from the Model Request Sandbox and eligible Agent Attempts. No local authenticated model client is constructed. Tool payloads, logs and saved evidence contain no raw key.

#### Scenario: Host key missing

- **WHEN** the model key is absent from the MCP environment
- **THEN** the server uses the stored secret for live work. An obsolete key in the environment has no effect. Saved evidence remains readable even without the sandbox token.

#### Scenario: Host mismatch

- **WHEN** a role selects an origin without its registered secret
- **THEN** the MCP reports that setup is required for that origin. It never sends another origin’s credential, falls back to a local key or dispatches a request through an unverified binding.

### Requirement: Discover and start inspections

Both clients SHALL discover ten titled tools with input and output schemas, plain summary-first text, accurate read-only and open-world hints, and usable structured success results. `start_inspection` SHALL accept a public GitHub repository as a URL, a Git remote address or `owner/repository`, return an Inspection ID immediately and continue work in the local server process.

#### Scenario: Inspect a slow repository

- **WHEN** the library emits its start event but the sandbox has yet to finish its first operation
- **THEN** the client receives the ID and polling guidance, and can issue another tool call while the Inspection proceeds

#### Scenario: No repository named

- **WHEN** the developer names no repository
- **THEN** the tool descriptions direct the agent to pass the GitHub origin of the current checkout. A call without one returns how to find it.

#### Scenario: Named repository

- **WHEN** the developer names a repository
- **THEN** the inspection uses that repository

#### Scenario: Repository is not public

- **WHEN** GitHub shows no public repository at the address
- **THEN** the caller receives a message that names the repository and says it must be public. No sandbox starts.

#### Scenario: Unacceptable source

- **WHEN** a caller supplies an address outside GitHub or the public clone cannot access the Repository
- **THEN** the caller receives a readable start error or a terminal failure under the issued ID, respectively

### Requirement: Follow live and recorded evidence

`read_inspection` SHALL return status, current step, ordered rolling log and highlighted, pinned Sandbox Events. It SHALL expose the terminal Inspection Report or failure reason. Start and read calls SHALL send current-step progress only during a live request with a supplied progress token.

#### Scenario: Poll and resume

- **WHEN** the caller reads after the last seen sequence
- **THEN** it receives subsequent events in order, a continuation cursor and the current step, including when no new events have arrived

#### Scenario: Progress lifetime

- **WHEN** a read waits briefly for more events with a progress token
- **THEN** the client receives labeled progress during that call and receives subsequent progress through later reads
- **AND** completing or cancelling a read ends its notifications and the Inspection continues

### Requirement: Recover private Inspection Reports

The MCP server SHALL save completed Inspection Reports with their exact Patch artifacts beneath `~/.health-code/inspections/`. A fresh session SHALL read them and their recorded application results without credentials. The library SHALL remain free of storage responsibilities. Local Inspections SHALL have no public site link.

#### Scenario: Restart between inspection and adoption

- **WHEN** a second server opens an Inspection ID after the first server saved it
- **THEN** it returns the same Inspection Report, timeline and available Patches from disk, including for a legacy report with no Patches

#### Scenario: No recoverable record

- **WHEN** a reader supplies an unknown ID, a malformed record or an ID from an interrupted process with no saved report
- **THEN** it reports the corresponding missing or unreadable record without starting another paid Inspection

### Requirement: Deliver a tested Patch

`get_tested_patch` SHALL return the identified Patch’s exact text, SHA-256 digest, library Verdict, inspected commit, prerequisite order and library agent prompt. The handoff SHALL establish the local checkout’s relationship to the inspected commit and direct the agent to verify the digest before applying, create a branch, run typecheck and tests without editing tests, and open a pull request with the developer’s authorization.

#### Scenario: Feature adoption on a different revision

- **WHEN** the checkout is ahead, behind or diverged according to local Git history
- **THEN** the handoff identifies the relationship before edits, names each prerequisite Patch and distinguishes a locally adapted result from the tested bytes

#### Scenario: Incomplete history or missing Patch

- **WHEN** local ancestry cannot be established
- **THEN** the handoff reports the comparison as unknown and supplies the inspected base
- **AND** if the report offers no such Patch, the tool explains its absence without generating a substitute

### Requirement: Record the developer’s result

`report_patch_result` SHALL record a developer-reported application outcome, adaptation description when applicable, test status and optional pull request URL against a saved Inspection and Patch. A later read SHALL distinguish these results from the library’s original Verdict.

#### Scenario: Record or retry adoption

- **WHEN** the client reports an adapted Patch, describes the edits and supplies failed tests or a pull request URL
- **THEN** the report survives restart and displays the submitted outcome, and an identical retry produces one record

#### Scenario: Invalid result

- **WHEN** the referenced Patch is absent, an adaptation lacks a description or the pull request URL is malformed
- **THEN** the tool returns an actionable error and preserves prior results

### Requirement: Choose a dependency upgrade

The MCP SHALL accept a repository URL in `list_upgrades` and return release features and an upgrade menu ID. A subsequent `get_upgrade` call SHALL return the selected version’s verified patch or recorded checks and reason. When the client requests progress, both tools SHALL forward ordered inspection, step and sandbox events during execution.

#### Scenario: Browse a saved upgrade menu

- **WHEN** the client uses `discover_upgrades` to inspect the lockfile and registry before installation or model calls, then reopens the upgrade menu with `list_upgrades`
- **THEN** the upgrade menu groups eligible targets by dependency, supports name search, sorts by minor availability, name or declaring workspace count, and can filter to targets with a verified local upgrade patch.

#### Scenario: Select one version

- **WHEN** the developer requests a target from the upgrade menu
- **THEN** the server SHALL return the verified patch from the existing inspection or inspect only that dependency and target version at the upgrade menu's commit.

The MCP SHALL offer `get_upgrade_features` for a version listed in the upgrade menu. Each feature SHALL cite upstream release evidence and identify the workspaces crossing that release. A preview SHALL use no sandbox or model call.

### Requirement: Check one upgrade in CI

The `health-code check` command SHALL test one eligible upgrade with the caller's account, write the Inspection Report and each verified mailbox to the output folder and print step progress. A partial report or a failed inspection SHALL exit nonzero. Delivery of a pull request belongs to the caller's pipeline.

#### Scenario: A pipeline tests a chosen version

- **WHEN** the caller names a dependency and version
- **THEN** the command confirms it is eligible, pins the commit that lists it and tests that version there.

#### Scenario: A pipeline is cancelled

- **WHEN** the process receives SIGTERM or SIGINT
- **THEN** the inspection stops and deletes its sandboxes before the process exits.

### Requirement: Show an app view

The server SHALL attach one app view to `list_upgrades`, `start_inspection` and `get_upgrade` for clients that support MCP Apps. The view SHALL show the upgrade menu, live progress with pinned Sandbox Events, Verdicts, checks and tested patches. It SHALL load nothing from the network. Clients without MCP Apps SHALL receive the same text and structured results.

#### Scenario: Page through dependencies

- **WHEN** a developer opens the next page of the upgrade menu
- **THEN** the dependency numbers continue from the previous page and the pager shows the range and the total that match the filters

#### Scenario: Choose and test an upgrade

- **WHEN** a developer selects an upgrade in the view
- **THEN** the view starts one inspection, follows its events and shows the Verdict, checks and patches when it finishes

#### Scenario: Test an upgrade that is already running

- **WHEN** a caller requests the same upgrade at the same commit while a test from `start_inspection` is running
- **THEN** the caller joins the running inspection and no second inspection starts. Cancelling the joined request leaves that inspection running.

#### Scenario: Apply a patch

- **WHEN** a developer asks to apply a tested patch from the view
- **THEN** the client receives one message with the inspection ID and the patch digest, and the coding agent retrieves and applies the patch

#### Scenario: Settings are missing

- **WHEN** a tool call fails because settings are missing
- **THEN** the view shows the error that names them

### Requirement: Read results and stop an inspection

`read_upgrade_results` SHALL return each upgrade's Verdict, checks, reason and patch references without mailbox text. `stop_inspection` SHALL cancel an active inspection of this server.

#### Scenario: Stop an active inspection

- **WHEN** a caller stops an active inspection
- **THEN** its sandboxes are deleted and later reads report a terminal status

#### Scenario: Nothing to stop

- **WHEN** the inspection is finished or unknown
- **THEN** the tool reports that no active inspection has that ID

### Requirement: Explain failures

Every failed tool call or inspection SHALL return its cause and a next step the coding agent can take. An inspection error SHALL include its code for bug reports. Unexpected errors SHALL expose no internal text.

#### Scenario: Account problem

- **WHEN** Runta rejects the token or its permissions
- **THEN** the message names the token or the missing access and where to fix it

#### Scenario: Temporary problem

- **WHEN** an inspection times out or Runta is unavailable
- **THEN** the message says to try again and what to change if it repeats

#### Scenario: Unfinished inspection

- **WHEN** a caller asks for the results of an inspection that is still running
- **THEN** the message says to poll it and no second inspection starts
