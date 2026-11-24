# Inspection engine

| Folder | Responsibility |
| --- | --- |
| root | The public entry, the report and event contracts, the inspection context, prompt templates and input normalization that every folder imports. |
| `inspection/` | Repository and project orchestration and the model engine. |
| `checks/` | The Node Ecosystem Adapter, Baseline and Upgrade Check comparison, test inventory and partial reports. |
| `upgrades/` | Registry targets, release notes, release features and the upgrade menu. |
| `models/` | Model budget, routes, prompt building, tracing and the Model Request Sandbox contract. |
| `patches/` | Agent Attempts, source and dependency edits, test-edit review and Patch verification. |
| `sandbox/` | The production and fake Sandbox Providers and the network policy. |

Folders import in one direction: root, `models/`, `sandbox/`, `upgrades/`, `checks/` and `patches/`, then `inspection/`. The file names below sit in these folders.

`index.ts` is the public library entry. `contracts.ts` owns the JSON report and event types, provider interface, and typed errors. `openRepositoryRuntime.ts` owns repository runtime allocation, checkout, network lockdown and replacement admission. `inspectRepository.ts` owns one bounded recovery attempt and final cleanup. `inspectProject.ts` runs the Baseline and serial upgrade checks.

`checkProject.ts` drives the Node Ecosystem Adapter and compares check evidence. `parseRegistryVersions.ts` separates completed registry lookups from timeouts and explains failed lookups. `selectUpgrades.ts` orders registry targets. `collectEvents.ts` owns per-inspection deadlines and callback delivery. `createFakeSandboxProvider.ts` replays caller-supplied fixtures. The `sandbox/` module owns the production provider.

Verify with the library tests and the root packed-package check. Keep the public entry usable in Node and Bun.

The public entry also exports Repository URL normalization and deployment-scoped startup cleanup.

`readModelRoutes.ts` resolves caller model settings for Anthropic and OpenAI-compatible hosts without choosing a model. `agentContracts.ts` defines the version 2 envelope. `inspectModels.ts` dispatches reading, matching and Agent Attempts. `modelBudget.ts` reserves per-request charges. `evaluatePatch.ts` reconstructs and checks proposed source edits before exporting the mailbox. Each proposed dependency is checked for newly introduced lifecycle hooks before its commit is accepted.

`attemptUpgrade.ts` drives repair and feature adoption. `requestAgentTurn.ts` verifies the scoped credential and accounts for each model turn. `fitAgentPrompt.ts` keeps each prompt within its route bound and lists omitted sources. `applyAgentEdits.ts` checks source scope and test edits. `prepareDependencies.ts` upgrades declared dependencies as one set and verifies additions and removals. Dependency additions and removals start from the committed tree so the observer sees links as the package manager creates them. The guest and supervisor share the structured edit schema in `proposeEdits.ts`. `verifyCandidate.ts` compares final installs, destinations, lifecycle hooks and test identities. `evaluatePatch.ts` publishes a mailbox only after replay. A changed existing expectation needs a separate flagged commit and independent checks on the current and upgraded versions. Added coverage must appear in the final test inventory. For repeated Baseline titles, every invocation must pass before and after, and the number of invocations must match.

`rankFeatureMatches.ts` verifies cited source locations. Direct replacements with a release quotation connecting the used symbol to the replacement rank first, followed by the number of distinct affected locations. Ties use dependency, source path, line, feature and release source. Only one adoption is attempted per upgrade. A declined match retains its source and disposition.

`confirmCheck.ts` compares repeat failures to the Baseline and retains the evidence for an untested check.

An Agent Attempt may add a test file beside a discovered suite with the same filename convention. Final verification must discover its named cases and see them pass.

A confirmed install failure can enter repair after a clean observation. The supervisor records the intended manifests and verifies the lockfile target before the first commit can qualify for a Patch.

`testInventorySummary.ts` reads current and historical test counts and test file errors. The web report and evaluation grader use the same schema.

`modelRequestSandbox.ts` defines model request sandbox options and serializes lazy allocation. `meterRuntimes.ts` measures each allocation through acknowledged deletion and combines runtime upper bounds with model receipts. Incomplete cleanup retains every unresolved identity on the Inspection error.

`readPrompt.ts` validates each Inspection’s bundled or caller-supplied Markdown and identifies effective templates by name, version and SHA-256. `buildPrompt.ts` fences bounded, redacted evidence at call time. `traceGeneration.ts` adapts an optional caller-owned tracer to the SDK’s per-call interface.

`inspectUpgrade.ts` runs the Install Check, confirms new failures and compares each Upgrade Check against the Baseline.

`listUpgrades.ts` exposes the two operations to discover an upgrade menu with release features and test one selected upgrade. `readUpgradeFeatures.ts` extracts bounded, source-linked feature entries from release notes for a chosen target. Set `mode: "listUpgrades"` to list eligible upgrades and release the sandbox before installation. Pass an exact `upgrade` and `revision` to test a chosen target. The public `health-code` entry groups, searches and sorts eligible versions.

`requestHostModel.ts` dispatches summaries and feature matching. It omits release notes from the end until the prompt fits its route bound. `mergeTestInventory.ts` combines test inventory and command results. `isPackagePath.ts` checks whether a module path names a package or one of its subpaths.
