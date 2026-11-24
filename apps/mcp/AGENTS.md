# Local MCP server

This workspace publishes the scoped launcher and owns the `health-code mcp` and `health-code check` commands, local setup, stdio tools and storage. Import inspection behavior from the public `health-code` entry.

| Entry | Responsibility |
| --- | --- |
| `cli.ts`, `createServer.ts` | Dispatch setup or stdio, validate tool input, format results and report request-scoped progress. |
| `modelSettings.ts`, `configureModels.ts`, `inspectWithAccount.ts` | Read the required model settings through the library, name the ones the client forwards and run inspections with the account’s origin-bound credential. No model is chosen by default. |
| `setupAccount.ts`, `probeModelRequestSandbox.ts` | Register or reuse the model key. Verify it with a request limited to one output token and confirm model request sandbox deletion before printing the client configuration. |
| `personalModelRequestSandboxes.ts` | Record each intended model request sandbox allocation by account and host. Use the verified organization ID across token rotations. Recover allocations whose local owner process has exited. |
| `checkRepository.ts` | Run `health-code check` for CI and write the report and patches. |
| `fixtures/` | Share recorded Inspection inputs and model replies between the MCP unit and packed stdio tests. |
| `trackInspections.ts`, `storeInspection.ts` | Own active tasks, abort on shutdown, page evidence and save private Inspection Reports and application results. |
| `listPatches.ts` | List dependency targets, patch digests and prerequisites with the inspection report. |
| `fetchPatch.ts` | Validate saved artifact bytes, order prerequisites and check developer-reported outcomes. |

Run `bun run --cwd apps/mcp build` after building the library. Run `bun test ./apps/mcp` for setup, tool behavior, package contents and Node stdio tests. The tests use temporary homes, a fake Sandbox Provider and recorded evidence. The package smoke test packs the public library, exercises `npx health-code mcp setup` with a fake account and connects to `npx health-code mcp` across process restarts. The app build emits JavaScript into `../../packages/health-code/dist/mcp/` for the shared release. See the root README for client configuration.

The MCP sets `callerModelExecution` to `"modelRequestSandbox"`. After setup a client needs `RUNTA_TOKEN` and the model settings. The MCP chooses no default model.

`launch.mjs` is the scoped npm entry. It resolves the matching library release and runs its declared CLI over stdio. The packed Node test exercises both entry points.

`browseUpgrades.ts` builds searchable, paginated upgrade menus from saved inspections. The list_upgrades tool accepts a repo URL and returns an upgrade menu with source-linked features. The get_upgrade tool waits for one target and returns verified patch bytes or its check results. It resolves one chosen target at its inspected commit and indexes verified local patch references.
