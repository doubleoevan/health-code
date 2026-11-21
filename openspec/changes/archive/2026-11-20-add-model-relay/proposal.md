# Keep the MCP user's model key in Runta after setup

## Why

Before this change, MCP setup stored the model key in Runta for Repair and Feature adoption, and developers also needed a local copy for release summaries and Feature Matches. With the Model Request Sandbox, a default MCP Inspection needs only `RUNTA_TOKEN` on the developer’s machine.

## What Changes

- Add a **Model Request Sandbox**, a dedicated runtime that sends authenticated model requests for one Inspection. The library builds bounded prompts and verifies replies. The model request sandbox receives no Repository checkout or tools.
- Let library callers select `callerModelExecution: "modelRequestSandbox"` for summaries and matching. The default, `"local"`, preserves the current model handles used by the web app and CarlNotes. Repair and Feature adoption keep their existing routes.
- Allocate the model request sandbox at the first eligible request. Verify its egress and stored-secret binding, record a pinned Sandbox Event, account for its runtime cost, and reclaim it on every exit. Teach orphan recovery to recognize its owner.
- Use model request sandbox mode for MCP Inspections. Setup can verify an existing stored key, or register or rotate a key supplied once. Print token-only client configuration after a successful authenticated probe and cleanup.

## Capabilities

### New Capabilities

The existing capabilities below own the change.

### Modified Capabilities

- `agent-attempts` defines the execution choice for the two caller-side roles.
- `sandbox-execution` defines the optional provider capability, credential boundary and model request sandbox recovery.
- `inspection-contract` defines the startup event and Report Card accounting.
- `local-mcp-inspections` defines setup, token-only live execution and migration.

## Impact

The public library, production and fake Sandbox Providers, local MCP package, event consumers, cost grader and module guides are affected. The change shares the current credential-stub adapter and prompt builders. It revisits the deferred isolated-model-calls proposal against the shipped library and MCP contracts. The launch reaper must recognize both runtime names for the same Inspection.
