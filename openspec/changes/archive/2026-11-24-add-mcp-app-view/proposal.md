# Add an app view to the MCP

## Why

The MCP returns text. A developer choosing an upgrade, following an inspection and reading a verdict has to do it through the coding agent. Clients that support MCP Apps can show an interactive page with a tool result. Setup also makes each developer keep the model host and model in their environment, though neither is secret.

## What Changes

- Show an app view with `list_upgrades`, `start_inspection` and `get_upgrade`. It covers the upgrade menu, live inspection progress, verdicts, checks and patches. Text results stay the same for other clients.
- Add `read_upgrade_results` for verdicts and patch references and `stop_inspection` to end an active inspection.
- Ask the coding agent to apply a patch from the view. The view never edits files.
- Print the model settings as values in the client configuration. Only `RUNTA_TOKEN` stays an environment reference.
- Name every missing setting and the setup command in one tool error.

## Capabilities

### Modified Capabilities

- `local-mcp-inspections` adds the app view, two tools and saved model settings.

## Impact

`apps/mcp` gains a React view bundled into the published library. The package boundary check lets `apps/mcp/view` import bundled development dependencies and Knip treats the view as an entry. The engine and the site stay the same.
