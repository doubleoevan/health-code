# App view

The page that clients with MCP Apps support show with a Health Code tool result. `bun run --cwd apps/mcp build` bundles it into `packages/health-code/dist/mcp/view/` and `../registerAppView.ts` serves it as one self-contained resource.

| Entry | Responsibility |
| --- | --- |
| `client.tsx` | Mounts the page and selects the screen from the tool result. |
| `connectHost.ts` | Exchanges MCP Apps messages with the client and calls this server's tools. |
| `CurrentStep.tsx`, `labels.ts` | Share the waiting line, version changes and repository names. |
| `UpgradeMenu.tsx` | Lists, filters and pages upgrades and starts a test. Asks the coding agent when the client drops the call. |
| `ReleaseFeatures.tsx` | Pages one version’s release features. |
| `InspectionView.tsx`, `readEvents.ts` | Follow one inspection and show its log and results. |
| `UpgradeResults.tsx` | Shows verdicts, checks, patch text and the request to apply a patch. |

Render repository and release text as text. Open links through the client and only over HTTPS. Keep that text out of chat messages. Load nothing from the network.

Run `bun run --cwd apps/mcp build` and `bun test ./apps/mcp`. Drive a changed screen in a browser through the official host bridge.
