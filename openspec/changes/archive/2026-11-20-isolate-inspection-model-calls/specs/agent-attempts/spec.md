# Agent attempts

## MODIFIED Requirements

### Requirement: Dispatch four caller-selected roles

A configured Inspection SHALL use the caller's models for release summaries, feature matching, repair and feature adoption. Summaries and matching SHALL use caller-process model handles by default. With isolated routing enabled, these roles SHALL use caller-selected stored-secret routes in a provider-owned runtime isolated from Repository code. Repair and feature adoption SHALL execute inside the sandbox with bounded repository editing and checking tools. Model providers, endpoints and model IDs SHALL come from the caller.

#### Scenario: Two consumers choose different routes

- **WHEN** one caller uses the same model for every role and another uses a custom OpenAI-compatible endpoint for matching and adoption
- **THEN** each role uses its caller's route and execution location, with credentials and usage isolated between callers.

#### Scenario: Caller selects isolated routing

- **WHEN** a caller supplies the isolated routing option and valid summary and matching routes
- **THEN** the provider sends both roles’ requests through scoped secret bindings, preserves their individual usage and releases the runtime on success, failure or cancellation

#### Scenario: Isolated routing unavailable

- **WHEN** the provider cannot establish the required isolation, binding or budget reservation
- **THEN** the library reports the failure, makes no direct host model call and cleans up acquired resources
