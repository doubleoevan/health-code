# Local MCP inspections

## MODIFIED Requirements

### Requirement: Connect personal accounts once

The existing unscoped `health-code` npm package SHALL start the Node stdio server with `npx health-code mcp`. The command `npx health-code mcp setup` SHALL check access using `RUNTA_TOKEN`, read the model key from the environment, store it through the Runta SDK and print exact credential-free Claude Code and Codex stdio configuration on success.

#### Scenario: Install one release

- **WHEN** a developer installs the packed `health-code` release in a fresh Node project
- **THEN** the public package entry exports the inspection library and `npx health-code mcp` serves the four tools
- **AND** setup prints Claude Code and Codex configurations that invoke `npx -y health-code@<installed-version> mcp`

#### Scenario: First setup and key rotation

- **WHEN** setup receives valid credentials directly or through a secret manager
- **THEN** it checks the account without starting an Inspection, writes the named secret and prints configuration referencing the sandbox token and omitting the model key
- **AND** repeating setup updates the same named secret for that host

#### Scenario: Setup fails

- **WHEN** an input is missing, authentication fails or the secret write fails
- **THEN** setup exits unsuccessfully with the failed step and a corrective action, prints no success configuration and discloses no credential on either output stream

### Requirement: Route personally funded inspections

The caller SHALL fund sandbox and model use. All roles SHALL default to Claude Opus 5.5 on Anthropic and accept model ID and host overrides. The MCP SHALL enable isolated routing for release summaries and Feature Matches. All four roles SHALL authenticate through host-bound secret stubs. The raw key SHALL stay outside the guest, tool payloads, logs and saved evidence. Optional GitHub credentials SHALL serve release-note retrieval only.

#### Scenario: First Inspection after setup

- **WHEN** setup has registered a model secret for each selected model origin and the client forwards only the sandbox token
- **THEN** all four selected model roles can authenticate without the MCP reading a local model key

#### Scenario: Stored secret missing

- **WHEN** the required stored secret cannot be resolved
- **THEN** the server identifies the setup action, avoids fallback to ambient credentials and still serves saved evidence

#### Scenario: Host mismatch

- **WHEN** a new model host lacks a matching registered secret
- **THEN** all four roles require setup for that origin and the gateway never forwards another origin’s stored credential
