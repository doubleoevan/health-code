# Accept model paths

## Why

The model settings always add `/v1` to the host. Providers with another API path, such as GLM, cannot be used through the MCP.

## What Changes

- Accept an API path in `HEALTH_CODE_MODEL_HOST`.
- Keep `/v1` when the address has no path.
- State the supported APIs on the npm page.

## Capabilities

### Modified Capabilities

- `local-mcp-inspections` changes the model host setting.

## Impact

`packages/health-code/src/readModelRoutes.ts`, its tests and the package guides change.
