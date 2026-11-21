# Sandbox execution delta

## MODIFIED Requirements

### Requirement: Isolate setup from repository execution

The provider SHALL allow trusted provisioning and acquisition of the pinned source during setup. Before executing any repository-controlled configuration, install, test or script, it SHALL replace and confirm the complete network policy with trusted package-registry hostnames only. Repository commands SHALL have no application secrets, real control-plane credentials or usable model binding. Only isolated trusted agent inference may temporarily use the separately verified model-host policy.

#### Scenario: Initial network access ends

- **WHEN** setup finishes
- **THEN** the effective policy allows the selected public registries, excludes GitHub, and the first repository command follows confirmation of that policy.

#### Scenario: Control state cannot be verified

- **WHEN** the provider cannot establish credential isolation or verify the requested network policy
- **THEN** it destroys the sandbox and reports a typed failure before executing repository code.

#### Scenario: Placeholder environment

- **WHEN** repository code or its example environment file names a required variable
- **THEN** the guest receives an inert placeholder for a statically discoverable application variable and reserved runtime controls keep their trusted settings.

## ADDED Requirements

### Requirement: Bind a stored credential for a single Agent Attempt

The Sandbox Provider SHALL offer an optional, provider-neutral capability to attach a named stored credential to a specific model host, path and request header through a value template. The real credential SHALL remain outside the library and sandbox. The provider SHALL verify the full replacement allowlist of package registries plus that model host before reporting agent startup. The fake SHALL record the request and transitions with inert metadata.

#### Scenario: Verified agent startup

- **WHEN** the provider confirms the exact binding and effective egress policy and its live authentication probe succeeds on the scoped route
- **THEN** the isolated agent may start and emit its Sandbox Event. The guest and the event contain only inert credential data.

#### Scenario: Provisioning a header binding through the released control plane

- **WHEN** the Runta provider attaches the stored credential on its dedicated runtime
- **THEN** it resolves the secret ID and sends the complete expected `secret_configuration` to `PATCH /v2/runtimes/{id}?expected_revision={revision}` through one private function. The egress rule names the exact host, path, header and value template with the literal `${secret}` token.

#### Scenario: A stored rule cannot authenticate

- **WHEN** the API accepts the rule but readback disagrees or the live probe fails, times out or cannot distinguish authenticated access
- **THEN** no Agent Attempt starts, no startup event is emitted, and the provider restores and verifies isolation or destroys the sandbox.

#### Scenario: Returning to tests or switching models

- **WHEN** inference ends, a repository check is requested, or the next role uses another host
- **THEN** the old process and binding lose access, the provider verifies the full replacement policy for the next phase, and no repository process runs during inference access.

#### Scenario: Capability unavailable or cleanup fails

- **WHEN** a provider lacks verified credential attachment, or readback, removal or policy restoration fails
- **THEN** it cannot start or continue that attempt, the report explains the missing control, and uncertain sandbox state triggers destruction with the existing cleanup guarantees.
