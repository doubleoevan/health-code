# Inspection library

The public ESM package `health-code` owns Repository inspections. Its single entry exports `listUpgrades`, `resolveUpgrade`, `readPullRequestTarget`, `getUpgrade`, `inspectRepository`, provider factories, errors, and the Inspection Report and Inspection Event types. It also exports the helpers the site and the CI command share: `toUpgradeMenuReport`, `toReleaseAgeNotice`, `explainedErrorCodes`, `packageManagerDisplayNames`, `isExactVersion`, `createFakeGithub` and `readPackageFileDigests`. The site, the CI command and scheduled consumers import by package name.

| Module | Responsibility |
| --- | --- |
| `src/` | Public contract and the `src/inspection/`, `src/checks/`, `src/upgrades/`, `src/models/` and `src/patches/` folders. |
| `src/sandbox/` | Production sandbox lifecycle, guest controls, and the fake provider. |
| `guest/` | Node Ecosystem Adapter commands and installation evidence collection inside the sandbox. |
| `prompts/` | Versioned instructions for four model roles, credential verification and Patch handoff. |
| `test/` | Offline tests, shared provider contract, and live fixture harness. |

Run `bun run --cwd packages/health-code build` from the root. The package emits JavaScript and declarations into `dist/` and builds the standalone guest modules. Verify the published shape with `bun run check:package` and verify production operations with `bun run test:provider`. Each module maintains its own AGENTS.md alongside the root README. The npm prepack hook also builds the CI command into `dist/cli/`. The library reads `package.json`, `prompts/` and the Guest bundles at run time only through `src/readPackageFile.ts`, so the standalone executable can embed the same files. The `health-code` bin points to its Node CLI. Pack the release from the repository root with `npm pack ./packages/health-code`.

The web report calls `buildInvestigationPrompt` to hand incomplete checks to a coding agent with bounded, fenced evidence.

The Node adapter supports npm, pnpm, Yarn, and Bun. Recognized Bun, Vitest, Jest and Node test runner scripts produce per-test evidence. Other scripts report their exit status. Type errors and failing tests on the original commit are excluded from upgrade comparisons. The optional live suite requires `RUNTA_TOKEN` and verifies registry access, installation observation, timeouts, and deletion. See `GUIDE.md` for the public call, event delivery, partial Inspection Reports, and typed errors.

A hosted consumer passes a stable deployment name to the provider factory and calls the public `reconcileSandboxes` operation before starting workers. The provider paginates runtime inventory, matches its reserved prefix and Inspection UUID, and reclaims abandoned allocations by runtime ID. Ordinary CLI allocations retain their existing names.

The four structured model roles select the version 2 Inspection Report (`InspectionReportV2`). Use `repair` and `featureAdoption` for Agent Attempt roles and `maxTurns` for their turn limits. Release summaries and matching use caller-configured host models. Repair and feature adoption use serializable guest routes. Their scoped credential must pass a live probe before the engine emits agent startup.

The public model request sandbox overload accepts serializable credential routes and emits a verified Model Request Sandbox startup event. Existing model handles select local execution by default. Both execution paths validate the same fenced prompts and model replies.

Pass an optional full Git SHA as `revision` to hold admission and checkout at the same commit. `libraryVersion` gives consumers the installed release for cache identity.
