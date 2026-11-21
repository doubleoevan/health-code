# Local MCP server

This workspace publishes the scoped launcher and owns the `health-code mcp` command, local setup, stdio tools and storage. Import inspection behavior from the public `health-code` entry.

| Entry | Responsibility |
| --- | --- |
| `cli.ts`, `createServer.ts` | Dispatch setup or stdio, validate tool input, format results and report request-scoped progress. |
| `modelSettings.ts`, `configureModels.ts`, `inspectWithAccount.ts` | Resolve the trusted model origin, per-role model IDs, price bounds and origin-bound credential references. |
| `setupAccount.ts`, `probeModelRequestSandbox.ts` | Register or reuse the stored model key. Verify it with a request limited to one output token and confirm model request sandbox deletion before printing the client configuration. |
| `personalModelRequestSandboxes.ts` | Record each intended model request sandbox allocation by account and host. Use the verified organization ID across token rotations. Recover allocations whose local owner process has exited. |
| `fixtures/` | Share recorded Inspection inputs and model replies between the MCP unit and packed stdio tests. |
| `trackInspections.ts`, `storeInspection.ts` | Own active tasks, abort on shutdown, page evidence and save private Report Cards and application results. |
| `fetchPatch.ts` | Validate saved artifact bytes, order prerequisites and check developer-reported outcomes. |

Run `bun run --cwd apps/mcp build` after building the library. Run `bun test ./apps/mcp` for setup, tool behavior, package contents and Node stdio tests. The tests use temporary homes, a fake Sandbox Provider and recorded evidence. The package smoke test packs the public library, exercises `npx health-code mcp setup` with a fake account and connects to `npx health-code mcp` across process restarts. The app build emits JavaScript into `../../packages/health-code/dist/mcp/` for the shared release. See the root README for client configuration.

The MCP sets `callerModelExecution` to `"modelRequestSandbox"`. A default client needs only `RUNTA_TOKEN` after setup.

`launch.mjs` is the scoped npm entry. It resolves the matching library release and runs its declared CLI over stdio. The packed Node test exercises both entry points.
