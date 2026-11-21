# sandbox-execution Specification

## Purpose
Give inspection checks a disposable execution environment with bounded resources and evidence of what an installer attempted.

## Requirements

### Requirement: Interchangeable sandbox providers

Providers SHALL support an authenticated availability check, sandbox creation, bounded command execution, file reads and writes, complete network policy replacement, reading attempted connections and filesystem changes for an observed command, and destruction. The production and fixture providers SHALL satisfy the same behavioral contract.

#### Scenario: Cheap credential check

- **WHEN** a consumer probes the provider with a missing, rejected, or expired token
- **THEN** it receives a typed availability error without allocating a sandbox or exposing the token

#### Scenario: Offline contract

- **WHEN** preflight runs without credentials
- **THEN** the shared contract runs against local fixture projects and canned evidence, skips the production provider, and executes no fixture scripts on the host

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

### Requirement: Attributable installation evidence

An Install Check SHALL record attempted destinations beyond the allowlist and files written outside the project by the installation and its descendants. Evidence SHALL identify observed hostnames when available, distinguish policy decisions from inferred attempts, and explicitly mark incomplete coverage. The same evidence rules SHALL apply to both providers.

#### Scenario: Install exits zero after an unexpected action

- **WHEN** a lifecycle script contacts an unlisted host or writes and then deletes a file outside the project
- **THEN** findings identify the observed destination or path, and the successful exit does not clear the finding

#### Scenario: Ambiguous destination or incomplete observation

- **WHEN** only an IP address is visible, a hostname cannot be attributed, or required observation fails
- **THEN** the evidence preserves what was observed and its uncertainty, and the engine cannot report an unobserved install as passed

### Requirement: Resource ownership and teardown

The engine SHALL apply the caller's time and cost limits to sandbox work and reserve time for teardown. Every allocated sandbox SHALL enter a destruction path on success, error, cancellation, or deadline. Acknowledged deletion SHALL precede its deletion event. A cleanup failure SHALL remain visible to the caller.

#### Scenario: A test times out

- **WHEN** a repository command outlives its deadline
- **THEN** the engine stops scheduling work, handles any still-running process through the provider, and attempts sandbox deletion in a finally block

#### Scenario: An allocation or deletion reply is lost

- **WHEN** the provider cannot tell whether its named allocation succeeded or its deletion completed
- **THEN** it reconciles that specific resource with bounded retries and reports unresolved cleanup with an identifier sufficient for the owner to retry

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
