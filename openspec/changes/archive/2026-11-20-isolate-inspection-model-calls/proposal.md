# Isolate summary and matching model calls

## Why

The first MCP release needs the model key in the coding client’s environment for release summaries and Feature Matches. Runta already stores that key for Agent Attempts. Using the same stored secret for all four roles lets a developer remove the key from the client after setup.

## What Changes

- Add an opt-in public library option to dispatch summary and matching requests through a provider-owned runtime isolated from Repository execution.
- Turn the option on in the MCP server. Setup continues reading the environment key for registration and rotation. Generated client configurations forward only runtime inputs.
- Include runtime usage and cleanup in Inspection budgets and existing evidence.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-attempts` extends the caller-selected role contract with optional isolated routing for summaries and matching.
- `local-mcp-inspections` uses the isolated route and removes the live host-key requirement.

## Impact

This archive preserves a deferred proposal. The initial MCP release uses the environment key for release summaries and Feature Matches. All eight isolated-routing tasks remain open. A future change can resume from this design and reconcile its deltas with the accepted Agent Attempt and local MCP specs. The library owns the proposed option and runtime lifecycle. The MCP workspace would select the option through the public package.
