# Agent Attempts

## MODIFIED Requirements

### Requirement: Dispatch four caller-selected roles

A configured Inspection SHALL use the caller’s models, endpoints and pricing. Release summaries and Feature Matches SHALL use the caller’s process by default, or a Model Request Sandbox when selected. Repair and Feature adoption SHALL execute inside the repository sandbox with bounded editing and checking tools.

#### Scenario: Two consumers choose different routes

- **WHEN** one caller supplies local model handles and another selects the model request sandbox with a custom OpenAI-compatible model route
- **THEN** each role uses its caller’s selected model and execution location. Credentials, responses and usage stay isolated between callers.

The public Agent Attempt role IDs SHALL be `repair` and `featureAdoption`. Their display labels SHALL be **Repair** and **Feature adoption**. Each role accepts `maxTurns` as its turn limit.

#### Scenario: Existing callers upgrade the library

- **WHEN** the web app or CarlNotes supplies existing model handles and omits `callerModelExecution`, or explicitly selects `"local"`
- **THEN** the caller receives the same version 2 model behavior with a provider that has no model request sandbox capability. A model-free caller still receives the version 1 contract.

#### Scenario: A caller selects the model request sandbox

- **WHEN** `callerModelExecution` is `"modelRequestSandbox"` and the two caller-side roles supply valid serializable routes and prices
- **THEN** the library sends each eligible role through the model request sandbox. It builds and validates each bounded, nonce-fenced prompt and result by the same rules as local mode. Repair and Feature adoption continue using their own credential sessions.

#### Scenario: One summary informs one match request

- **WHEN** an Upgrade has release evidence and pinned usage
- **THEN** its summary is processed before its separate matching request. Each role has its own pricing, model receipt, output bound and validated citations. An Upgrade with no usage skips matching. Missing release evidence skips both requests.

#### Scenario: Incompatible caller options

- **WHEN** a caller selects model request sandbox execution with local handles, invalid routes or a provider lacking the capability
- **THEN** the library returns a typed configuration error before allocating resources or sending paid requests. Model request sandbox authentication and transport failures never trigger a local model request.
