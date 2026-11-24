# Guide MCP callers

## Why

The MCP needs a full repository URL even when the developer means the checkout they are in. Several failures return a status code, so the coding agent cannot say what went wrong or what to do next.

## What Changes

- Use the current checkout's GitHub origin when the developer names no repository.
- Accept `owner/repository` and Git remote addresses.
- Check that GitHub shows the repository publicly before creating a sandbox.
- Return the cause and the next step for each failure.

## Capabilities

### Modified Capabilities

- `local-mcp-inspections` changes repository input and failure messages.

## Impact

`apps/mcp` changes, including `health-code check` messages. The library and the site stay the same.
