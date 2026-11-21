# Sandbox execution

## ADDED Requirements

### Requirement: Send authenticated requests through a Model Request Sandbox

A Sandbox Provider MAY offer a Model Request Sandbox. The capability SHALL send a bounded request with a verified stored credential and return bounded output and usage. The model request sandbox SHALL contain only trusted inference code and receive bounded evidence as data. It SHALL run separately from the Repository, without its checkout, mounts, commands or tools. Egress SHALL permit only the active model host.

#### Scenario: A request uses the developer’s stored credential

- **WHEN** the model request sandbox sends a model request
- **THEN** the provider has verified the effective egress policy and exact HTTPS destination, path, header and stored-secret reference. Only the gateway supplies the real key. The local MCP, both runtimes, diagnostics and Report Card never receive it.

#### Scenario: Two roles select different hosts

- **WHEN** the second role selects a different route
- **THEN** the provider serializes the transition, revokes the previous binding and verifies the replacement policy and credential before dispatch. It refuses redirects and unverified control state. Repository commands retain their own network policy.

#### Scenario: Offline provider contract

- **WHEN** the shared contract uses the fake Sandbox Provider
- **THEN** it can inspect allocation, routes, bounded requests, usage and cleanup using inert references, canned replies and injected faults without external credentials or network traffic.

### Requirement: Own and recover one model request sandbox per Inspection

An Inspection SHALL lazily allocate at most one Model Request Sandbox at the first eligible request and reuse it until teardown. The provider SHALL identify it as a sibling of the Inspection’s repository sandbox under the same owner prefix. The engine SHALL attempt cleanup of both resources independently on every exit.

#### Scenario: No request qualifies

- **WHEN** the Inspection finishes without an eligible model request
- **THEN** it allocates no model request sandbox and incurs no model request sandbox charge.

#### Scenario: Two requests arrive together

- **WHEN** the first two eligible requests for the same Inspection arrive concurrently
- **THEN** they share one allocation and each executes under its own verified route.

#### Scenario: A callback or Inspection fails after allocation

- **WHEN** creation is ambiguous, a callback throws, the caller cancels, or the deadline expires
- **THEN** cleanup attempts revocation and deletion of every possibly allocated resource within the cleanup allowance. Failure of one cleanup does not suppress the other. A typed failure identifies every unresolved resource.

#### Scenario: Reaping similarly named runtimes

- **WHEN** recovery inventories a repository sandbox and its model request sandbox sibling for an interrupted Inspection
- **THEN** the reaper recognizes both from the owning namespace and exact Inspection identity, even when the creation response was lost. It preserves live siblings, lookalike names, other deployments and other active MCP sessions.

#### Scenario: Model request sandbox call deadline

- **WHEN** a summary or Feature Match is dispatched through the model request sandbox
- **THEN** the call has at most 120 seconds and ends sooner when the remaining Inspection work time expires. The teardown reserve remains available.
