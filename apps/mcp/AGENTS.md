# Local MCP server

This private workspace owns the `health-code mcp` command, local setup, stdio tools and storage. Import inspection behavior from the public `health-code` entry.

| Entry | Responsibility |
| --- | --- |
| `cli.ts`, `createServer.ts` | Dispatch setup or stdio, validate tool input, format results and report request-scoped progress. |
| `modelSettings.ts`, `configureModels.ts`, `inspectWithAccount.ts` | Resolve the trusted model origin, per-role model IDs, price bounds, host handles and guest credential references. |
| `setupAccount.ts` | Check account access, store the model key with the Runta SDK and print client configuration using environment references. |
| `trackInspections.ts`, `storeInspection.ts` | Own active tasks, abort on shutdown, page evidence and save private Report Cards and application results. |
| `fetchPatch.ts` | Validate saved artifact bytes, order prerequisites and check developer-reported outcomes. |

Run `bun run --cwd apps/mcp build` after building the library. Run `bun test ./apps/mcp` for setup, tool behavior, package contents and Node stdio tests. The tests use temporary homes, a fake Sandbox Provider and recorded evidence. The package smoke test packs the public library, exercises `npx health-code mcp setup` with a fake account and connects to `npx health-code mcp` across process restarts. The app build emits JavaScript into `packages/health-code/dist/mcp/` for the shared release. See the root README for client configuration.
