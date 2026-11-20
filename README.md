# Health Code

Health Code inspects dependency upgrades in public GitHub repositories inside a Runta sandbox.
Its TypeScript library powers the site and MCP server. [Hosted site](https://runhealthcode.dev)

## Development

Use the Bun version in `.bun-version`. From the repository root, run `bun install --frozen-lockfile`, then `bash scripts/preflight.sh`. The product workspaces are empty. The test suite exercises the engineering checks with local fixtures.

| Command | What it checks |
| --- | --- |
| `bun run check` | Runs preflight, the same command used by CI and /ship. Stops at the first failure. |
| `bun run check:style` | Checks formatting, lint rules, and import order with Biome. |
| `bun run check:structure` | Checks the placement of package manifests. |
| `bun run check:boundaries` | Checks imports, dependency declarations, and TypeScript references across the workspaces. |
| `bun run check:pins` | Compares the Bun pins and verifies patched dependency versions against the lockfile. |
| `bun run check:unused` | Finds unused files, exports, types, and dependencies with Knip. |
| `bun run typecheck` | Typechecks the scripts and every product workspace. |
| `bun run test` | Runs the tooling and workspace test suites with Bun. |
| `bun run check:advisories` | Queries the registry and fails on unreviewed high or critical advisories or stale exceptions. CI runs it separately. |

Preflight needs no credentials. Doppler project `health-code`, config `dev`, holds application secrets. See [AGENTS.md](AGENTS.md) for module ownership, test rules, and the shipping workflow.
