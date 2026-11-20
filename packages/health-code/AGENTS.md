# Inspection library

The public ESM package `health-code` owns Repository inspections. Its single entry exports `inspectRepository`, provider factories, errors, and the Report Card and Inspection Event types. The site, MCP server, and scheduled consumers import by package name.

| Module | Responsibility |
| --- | --- |
| `src/` | Public contract, inspection orchestration, checks, and fake provider. |
| `src/sandbox/` | Production sandbox lifecycle and guest controls. |
| `guest/` | Node Ecosystem Adapter commands and installation evidence collection inside the sandbox. |
| `test/` | Offline tests, shared provider contract, and live fixture harness. |

Run `bun run --cwd packages/health-code build` from the root. The package emits JavaScript and declarations into `dist/` and builds two standalone guest modules. Verify the published shape with `bun run check:package` and verify production operations with `bun run test:provider`. Each module maintains its own AGENTS.md alongside the root README.

The Node adapter supports npm, pnpm, Yarn, and Bun. Recognized Bun, Vitest, and Jest scripts produce per-test evidence. Other scripts report their exit status. The optional live suite requires `RUNTA_TOKEN` and verifies registry access, installation observation, timeouts, and deletion. See the root README for the public call, event delivery, partial Report Cards, and typed errors.
