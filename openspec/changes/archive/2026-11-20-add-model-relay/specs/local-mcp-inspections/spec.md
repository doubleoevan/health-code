# Local MCP inspections

## MODIFIED Requirements

### Requirement: Connect personal accounts once

The unscoped `health-code` npm package SHALL start the Node stdio server with `npx health-code mcp`. The command `npx health-code mcp setup` SHALL check account access, register or reuse the origin-bound stored secret, verify it with one bounded authenticated model request sandbox request, and confirm cleanup before printing Claude Code and Codex configuration. The default client configuration SHALL forward only `RUNTA_TOKEN` by name.

#### Scenario: Install one release

- **WHEN** a developer installs the packed release in a fresh Node project
- **THEN** the public entry exports the library, the MCP serves its four tools, and both printed client entries launch the installed version using the existing pinned command from the user’s home.
- **AND** the default Claude Code environment and Codex environment list each contain only the token reference.

#### Scenario: First setup and key rotation

- **WHEN** the user supplies a model key to setup for the selected HTTPS origin
- **THEN** it stores or rotates the same named secret, tests it through an ephemeral model request sandbox with a fixed one-output-token request, and deletes the model request sandbox. It makes no Repository checkout or Inspection and prints no key.

#### Scenario: Setup fails

- **WHEN** account access, registration, secret lookup, model request sandbox authentication or cleanup fails
- **THEN** setup exits unsuccessfully with a corrective action and any needed cleanup identifier. It prints no success configuration, request headers, model key, token value or upstream response body.

#### Scenario: Existing registration

- **WHEN** setup has only the sandbox token and that origin already has the expected secret
- **THEN** it verifies the stored key through the model request sandbox without downloading, replacing or requesting the key again. A missing secret produces registration instructions for that origin.

### Requirement: Route personally funded inspections

The caller SHALL fund sandbox, model request sandbox and model use. All four roles SHALL default to Claude Opus 5.5 on Anthropic and accept configured model ID and host overrides. The MCP SHALL select model request sandbox execution for summaries and Feature Matches and use the existing sandbox binding for Repair and Feature adoption. Live MCP Inspections SHALL require only `RUNTA_TOKEN` at default settings. An optional GitHub credential SHALL serve release retrieval only.

#### Scenario: First Inspection after setup

- **WHEN** the client supplies only the sandbox token after a successful default setup
- **THEN** it can complete and save an Inspection, including summaries and Feature Matches from the Model Request Sandbox and eligible Agent Attempts. No local authenticated model client is constructed. Tool payloads, logs and saved evidence contain no raw key.

#### Scenario: Host key missing

- **WHEN** the model key is absent from the MCP environment
- **THEN** the server uses the stored secret for live work. An obsolete key in the environment has no effect. Saved evidence remains readable even without the sandbox token.

#### Scenario: Host mismatch

- **WHEN** a role selects an origin without its registered secret
- **THEN** the MCP reports that setup is required for that origin. It never sends another origin’s credential, falls back to a local key or dispatches a request through an unverified binding.
