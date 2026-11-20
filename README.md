# Health Code

Health Code inspects dependency upgrades in public GitHub repositories inside a Runta sandbox.
Its TypeScript library is the shared engine for the planned site and MCP server. [Hosted site](https://runhealthcode.dev)

## Inspect a repository

The `health-code` package exports the same ESM entry to Node and Bun. Supply a Sandbox Provider and consume the returned versioned JSON Report Card. Each caller owns storage and scheduling.

```ts
import { createSandboxProvider, inspectRepository } from "health-code"

const card = await inspectRepository({
  repositoryUrl: "https://github.com/ai/nanoid",
  sandboxProvider: createSandboxProvider(),
  limits: { maxUpgrades: 6, maxDurationMs: 1_800_000, maxCostUsd: 0.25 },
  onEvent(event) {
    console.log(event.sequence, event.type)
  },
})
console.log(card.repository.commit, card.upgrades)
```

Use `provider.checkAvailability()` to check a credential without allocating a sandbox. `SandboxUnavailableError` identifies authentication, permission, and availability errors. Other fatal inspection errors carry the event timeline and any unresolved cleanup identifier. A partial Report Card explains untested checks.

The live sandbox has 4 GiB of physical memory. Tools such as oxlint can reserve larger virtual address ranges and consume RAM as they use the pages.

The Node adapter supports npm, pnpm, Bun, and Yarn workspaces. It selects stable minor and major upgrades and confirms new failures against the pinned Baseline. Consumers can highlight Sandbox Events in a live log or replay them from the report timeline.

Read each upgrade's `install.status` for the install command's Check Result. Its `observation.findings` list records off-registry connections, connection attempts with an unknown destination hostname, and writes outside the project. Check `observation.complete` alongside that list. Even an empty list leaves the Upgrade Check untested when coverage is incomplete.

## Development

Use the Bun version in `.bun-version`. From the repository root, run `bun install --frozen-lockfile`, then `bash scripts/preflight.sh`. The test suite covers repository checks and the inspection engine using recorded fixtures.

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
| `bun run --cwd packages/health-code build` | Builds the ESM library, declarations, and the sandbox guest tools. |
| `bun run inspect <repo-url> [--fake]` | Prints the live inspection log and saves the versioned Report Card to `logs/`. Use `--fake` for a credential-free fixture replay. For a live inspection, use `doppler run -- bun run inspect <repo-url>`. |
| `bun run check:package` | Packs the library and verifies its public entry in fresh Node and Bun consumers with frozen workspace dependencies. |
| `bun run test:provider` | Runs the shared production contract and two pinned public fixtures when the test harness has `RUNTA_TOKEN`. |
| `bun run check:advisories` | Queries the registry and fails on unreviewed high or critical advisories or stale exceptions. CI runs it separately. |

Every module keeps its own AGENTS.md current with this README. For an approved change, implement it, run `/ship`, archive with OpenSpec, commit the implementation and archive together, then push to main.

Preflight needs no credentials. Doppler project `health-code`, config `dev`, holds application secrets. See [AGENTS.md](AGENTS.md) for module ownership, test rules, and the shipping workflow.
