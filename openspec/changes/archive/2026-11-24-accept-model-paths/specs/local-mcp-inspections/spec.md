## MODIFIED Requirements

### Requirement: Route personally funded inspections

The caller SHALL fund sandbox, model request sandbox and model use. The caller SHALL configure the model host and a model ID, with optional price bounds and an optional model ID per role. Unset price bounds SHALL default to $10 per million input tokens and $50 per million output tokens. The MCP SHALL name every missing setting and the setup command in one error and choose no model itself. It SHALL support Anthropic and OpenAI-compatible hosts. A model host SHALL accept an API path and use `/v1` when it has none. The MCP SHALL select model request sandbox execution for summaries and Code Feature Matches and use the existing sandbox binding for Repair and Feature adoption. Live MCP Inspections SHALL require `RUNTA_TOKEN` and the model settings, with the key stored in Runta. An optional GitHub credential SHALL serve release retrieval only.

#### Scenario: First Inspection after setup

- **WHEN** the client supplies the sandbox token and model settings after a successful setup
- **THEN** it can complete and save an Inspection, including summaries and Code Feature Matches from the Model Request Sandbox and eligible Agent Attempts. No local authenticated model client is constructed. Tool payloads, logs and saved evidence contain no raw key.

#### Scenario: Host key missing

- **WHEN** the model key is absent from the MCP environment
- **THEN** the server uses the stored secret for live work. An obsolete key in the environment has no effect. Saved evidence remains readable even without the sandbox token.

#### Scenario: Host mismatch

- **WHEN** a role selects an origin without its registered secret
- **THEN** the MCP reports that setup is required for that origin. It never sends another origin’s credential, falls back to a local key or dispatches a request through an unverified binding.

#### Scenario: Model host with a path

- **WHEN** the model host includes an API path
- **THEN** every model request uses that path and the stored key stays named for the origin
