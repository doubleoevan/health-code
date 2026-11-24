## MODIFIED Requirements

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

Both clients SHALL discover ten titled tools with input and output schemas, plain summary-first text, accurate read-only and open-world hints, and usable structured success results. `start_inspection` SHALL accept a public GitHub Repository URL, return an Inspection ID immediately and continue work in the local server process.

#### Scenario: Inspect a slow repository

- **WHEN** the library emits its start event but the sandbox has yet to finish its first operation
- **THEN** the client receives the ID and polling guidance, and can issue another tool call while the Inspection proceeds

#### Scenario: Unacceptable source

- **WHEN** a caller supplies a non-GitHub URL or the public clone cannot access the Repository
- **THEN** the caller receives a readable start error or a terminal failure under the issued ID, respectively

## ADDED Requirements

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
