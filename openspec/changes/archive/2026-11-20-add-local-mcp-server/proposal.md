# Local MCP server for Health Code

## Why

A developer who sees a useful dependency Patch should be able to inspect their own public Repository from Claude Code or Codex. One setup command connects their Runta account and registers their existing model key so they can start the first Inspection without copying a credential twice.

## What Changes

- Ship the CLI in the existing unscoped `health-code` package. Run setup with `npx health-code mcp setup` and serve either client with `npx health-code mcp`.
- Offer four tools to start an Inspection, follow its evidence, retrieve a tested Patch and record what happened when the developer applied it.
- Keep active work in the local server process. Save finished Report Cards and application results under the developer’s home directory.
- Document the account charges, credential flow and a complete example. Exercise the published package and all four tools offline.

## Capabilities

### New Capabilities

- `local-mcp-inspections` covers setup, local Inspection access, Patch handoff and durable results for coding agents.

### Modified Capabilities

None.

## Impact

`apps/mcp` owns the executable, tool contract, setup and storage. It imports the public `health-code` entry. Consume the public role and Patch contracts delivered by `agents-and-patches`. The MCP reads the environment key for release summaries and Feature Matches. Setup stores that key in Runta for repair and feature adoption. The library workspace owns the release manifest and packs the compiled CLI alongside its public library entry. The later `isolate-inspection-model-calls` proposal moves the first two roles behind a library option. This change also updates package checks, module guides and the README. Site publication stays with `apps/web`.
