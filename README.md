# Health Code

Health Code inspects dependency upgrades in public GitHub repositories inside a Runta sandbox.
Its TypeScript library is the shared engine for the site and MCP server. [Hosted site](https://runhealthcode.dev)

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

## Inspection site

Build the library with `bun run --cwd packages/health-code build`, then run `bun run --cwd apps/web dev`. Open `http://localhost:3000` and submit the prefilled fixture URL. The same short link displays the live log and the completed Report Card. Development replay streams a recorded library inspection with fixture model responses.

The live server runs all four model roles with Claude Opus 5.5. Reports publish verified Patch bytes and application prompts when GitHub detects an OSI-approved license at the inspected commit. See [site operations](apps/web/AGENTS.md) for the Northflank Dockerfile, SQLite backups, deployment namespace and startup recovery.

To apply a tested Patch from a licensed Report Card, choose **Copy patch instructions** and paste them into Claude Code or Codex from the repository checkout. The instructions include the download URL, SHA-256 digest and tested commit. A Feature Patch also identifies its required Upgrade Patch.

## MCP setup

Health Code runs as a local Node stdio server in Claude Code or Codex. The server saves evidence on your machine. Your Runta account pays for sandbox time and your model account pays for inference. The coding agent uses its own checkout and GitHub permissions for the pull request.

The next `health-code` npm release includes the library and the MCP executable. It supports Node 22.18 or later on the 22.x line, or Node 24.11 and later.

1. Create a Runta account and set `RUNTA_TOKEN`. The token needs access to runtimes, secrets and the model-provider list for your organization. For first-time registration or rotation, also supply `ANTHROPIC_API_KEY` to the setup process. [Runta signup](https://dashboard.runta.com)
2. From your home directory, run `npx health-code mcp setup`. Setup verifies the stored key with one authenticated request in a Model Request Sandbox, deletes the model request sandbox, then prints both client entries. You can repeat setup with just `RUNTA_TOKEN` once the origin’s key is registered.
3. Paste the Claude Code entry inside `mcpServers` in the project’s `.mcp.json`, or the Codex entry at the top level of `~/.codex/config.toml`. Both pin the installed version and resolve the command from your home directory.
4. Start or restart your client with `RUNTA_TOKEN`. The MCP uses the model key stored in Runta for all four roles. When migrating an existing configuration, replace the old client entry and remove its model-key reference. You can remove your local model key after setup succeeds.

Library callers can select `callerModelExecution: "modelRequestSandbox"` and pass stored-credential routes for all four roles. Omitting the option keeps summaries and Feature Matches in the caller’s process. A model request sandbox starts on the first eligible request. Each model request sandbox call has up to 120 seconds within the Inspection’s remaining work time. The Report Card records runtime cost bounds separately from model charges. **Usage as of** (`runtimeUsage.usageAsOf`) gives the time through which runtime usage was measured.

To use an unpublished checkout, build the library with `bun run --cwd packages/health-code build`, then run `bun run --cwd apps/mcp build`. Use `node packages/health-code/dist/mcp/cli.js mcp setup` in your secret environment. In the printed client entry, use `node` as the command and pass the absolute path to that file followed by `mcp` as the arguments.

| Environment variable | Use |
| --- | --- |
| `RUNTA_TOKEN` | Account check, secret registration and live sandbox access. |
| `ANTHROPIC_API_KEY` | One-time registration or rotation during setup. |
| `HEALTH_CODE_MODEL_HOST` | HTTPS Anthropic-compatible origin. Defaults to `https://api.anthropic.com`. Run setup for the chosen origin. |
| `HEALTH_CODE_SUMMARY_MODEL`, `HEALTH_CODE_MATCH_MODEL`, `HEALTH_CODE_REPAIR_MODEL`, `HEALTH_CODE_ADOPTION_MODEL` | Select each live model role. The default is `claude-opus-5-5`. |
| `HEALTH_CODE_INPUT_USD_PER_MILLION`, `HEALTH_CODE_OUTPUT_USD_PER_MILLION` | Upper bounds for model cost reservations. Supply both for a custom host or model. |
| `GITHUB_TOKEN` | Optional release-note access for public repositories. To opt in, add this variable to the client entry. |

### Example agent session

Ask your agent to **inspect this repository, read the Report Card and apply the feature Patch**.

1. Call `start_inspection` with `repositoryUrl` set to the public GitHub HTTPS URL. Keep the returned `inspectionId` and the stdio process open while the Inspection runs.
2. Call `read_inspection` using that ID. For the next log page pass `nextSequence` as `afterSequence`. Sandbox Events appear in the pinned list. Follow `report.nextOffset` with `reportOffset` to read the completed card.
3. Compare the local remote and HEAD with the inspected Repository and commit. Use Git ancestry to distinguish ahead, behind and diverged. Report unknown if history is incomplete. Call `get_tested_patch` with the ID, selected `sha256` and optional `checkout` relationship and dirty flag.
4. Concatenate each Patch’s text pages verbatim. Verify the SHA-256 digest, follow the library prompt and apply the prerequisite series first on a new branch. Run the typecheck and tests without editing tests. Open the authorized pull request.
5. Call `report_patch_result` with the ID, digest, `application` (clean or adapted), `tests` (passed, failed or not_run) and optional `pullRequest`. Supply `adaptation` for an adapted Patch.

Completed Report Cards live under `~/.health-code/inspections/<inspection-id>/card.json`. Restart either client and read by the same ID without credentials. Developer-reported results are separate from the library Verdict. Closing the local server interrupts active Inspections. Public links belong to hosted Inspections.

## Development

Use the Bun version in `.bun-version`. From the repository root, run `bun install --frozen-lockfile`, then `bash scripts/preflight.sh`. The test suite covers repository checks and the inspection engine using recorded fixtures. Claude Code runs the same comment check after file edits and writes. Hook mode uses `jq` to read the edited path. For `.tsx`, follow the JSX section-comment rules and review them during `/ship`.

| Command | What it checks |
| --- | --- |
| `bun run check` | Runs preflight, the same command used by CI and /ship. Stops at the first failure. |
| `bash scripts/check-comment-groups.sh --tracked` | Flags runs over eight uncommented statement lines in tracked `.ts`, `.mts`, `.js`, `.mjs` and `.sh` files. |
| `bun run check:style` | Checks formatting, lint rules, and import order with Biome. |
| `bun run check:structure` | Checks the placement of package manifests. |
| `bun run check:boundaries` | Checks imports, dependency declarations, and TypeScript references across the workspaces. |
| `bun run check:pins` | Compares the Bun pins and verifies patched dependency versions against the lockfile. |
| `bun run check:unused` | Finds unused files, exports, types, and dependencies with Knip. |
| `bun run typecheck` | Typechecks the scripts and every product workspace. |
| `bun run test` | Runs the tooling and workspace test suites with Bun. |
| `bun run --cwd packages/health-code build` | Builds the ESM library, declarations, and the sandbox guest tools. |
| `bun run inspect <repo-url> [--fake]` | Prints the live inspection log and saves the versioned Report Card to `logs/`. Use `--fake` for a credential-free fixture replay. For a live inspection, use `doppler run -- bun run inspect <repo-url>`. |
| `bun run --cwd apps/mcp build` | Compiles the Node CLI from `apps/mcp` into `packages/health-code/dist/mcp/`. |
| `bun test ./apps/mcp` | Exercises the four tools, account setup, private storage and the packed Node subprocess offline. |
| `bun run --cwd apps/web build` | Builds the Vite browser entry for the Hono server. |
| `bun run --cwd apps/web start` | Serves the built page, Inspection API and event stream. |
| `bun run --cwd apps/web dev` or `replay` | Serves credential-free replay with React Fast Refresh, live CSS and server source reload. |
| `bun run check:package` | Packs the library and verifies its public entry in fresh Node and Bun consumers with frozen workspace dependencies. |
| `bun run test:provider` | Runs the shared production contract and two pinned public fixtures when the test harness has `RUNTA_TOKEN`. |
| `doppler run -- bun run eval --case typescript-7` | Scores the historical repair under the default limits. `--all` scores both cases. |
| `doppler run --only-secrets RUNTA_TOKEN -- bun run eval --case carlnotes-baseline --record` | Measures test counts and test file errors at the pinned commit and writes the case file for review. |
| `bun run check:advisories` | Queries the registry and fails on unreviewed high or critical advisories or stale exceptions. CI runs it separately. |

Every module keeps its own AGENTS.md current with this README. For an approved change, implement it, run `/ship`, archive with OpenSpec, commit the implementation and archive together, then push to main.

Preflight needs no credentials. Doppler project `health-code`, config `dev`, holds application secrets. See [AGENTS.md](AGENTS.md) for module ownership, test rules, and the shipping workflow.

### Inspections with models

Pass configured model handles in `models.releaseSummary` and `models.featureMatch`. Give each a caller-owned pricing bound in USD per million input and output tokens and a maximum input token count. For `models.repair` and `models.featureAdoption`, supply the protocol, HTTPS base URL, model ID, pricing and a stored credential name with its header and value template. The library verifies the scoped binding inside the sandbox. Each returned Patch includes its tested commit, mailbox and application instructions.

An Inspection with models defaults to 60 minutes and $15. Repair gets up to 40 turns, 20 minutes and $4. Feature adoption gets up to 25 turns, 10 minutes and $2. Each agent turn allows up to 8,192 output tokens. Set a lower turn limit with `limits.agent.repair.maxTurns` or `limits.agent.featureAdoption.maxTurns`. Set total spending and time under `limits`. Existing model-free calls and legacy string dictionaries return version 1.

A caller can use the same configured model for summaries and matching. The guest route carries the stored credential name. The two model handles stay in the calling process.

```ts
import { inspectRepository } from "health-code"

const report = await inspectRepository({ repositoryUrl, sandboxProvider, models })
```

Run `bun run test:credential` with the sandbox token and `HEALTH_CODE_STORED_CREDENTIAL` set to the stored Anthropic key's name to verify the live gateway. Run `bun run eval --case typescript-7` to score the pinned repair against the default budgets. The CarlNotes case supports `--record` for a new measurement. Scoring requires reviewed counts and test file errors.


The public type for a version 2 Report Card is `ReportCardV2`. The product calls it a **Report Card**. A **Direct replacement** cites release text connecting the feature to its **Source location**. An **Inferred replacement** records the evidence available. The report also identifies **Affected call sites** and the **Adoption outcome** for each match.

A **Final patch check** produces **Patch verification**. **Download patch** provides the Git mailbox. **Applies to commit**, **Tested commit** and **Required upgrade patch** identify how to apply it. Each entry under **Added dependencies** identifies the reviewed commit. **Why repair stopped** gives the recorded diagnosis. **Installed size change** reports the difference in bytes.

**Model cost** uses recorded token usage and the caller’s pricing. **Reserved upper bound** shows the amount retained for a request whose receipt is missing. **Output tokens** reports measured reply tokens.

The **Test file errors** list (`testFileErrors`) records the file and reason for each load, setup or other runner error outside a named case. Named test failures and skips have their own counts.
