# Inspection engine

`index.ts` is the public library entry. `contracts.ts` owns the JSON report and event types, provider interface, and typed errors. `inspectRepository.ts` owns allocation, the pinned Baseline, candidate sequencing, and finally-block cleanup.

`checkProject.ts` drives the Node Ecosystem Adapter and compares check evidence. `selectUpgrades.ts` orders registry candidates. `collectEvents.ts` owns per-inspection deadlines and callback delivery. `createFakeSandboxProvider.ts` replays caller-supplied fixtures. The `sandbox/` module owns the production provider.

Verify with the library tests and the root packed-package check. Keep the public entry usable in Node and Bun.

The public entry also exports Repository URL normalization and deployment-scoped startup cleanup.

`agentContracts.ts` defines the version 2 envelope. `inspectModels.ts` dispatches reading, matching and Agent Attempts. `modelBudget.ts` reserves per-request charges. `verifyPatch.ts` reconstructs and checks proposed source edits before exporting the mailbox. Each proposed dependency is checked for newly introduced lifecycle hooks before its commit is accepted.

`attemptUpgrade.ts` drives repair and feature adoption. `requestAgentTurn.ts` verifies the scoped credential and accounts for each model turn. `applyAgentEdits.ts` checks source scope, dependency declarations and test edits. Dependency additions and removals start from the committed tree so the observer sees links as the package manager creates them. The guest and supervisor share the structured edit schema in `proposeEdits.ts`. `verifyCandidate.ts` compares final installs, destinations, lifecycle hooks and test identities. `verifyPatch.ts` publishes a mailbox only after replay. A changed existing expectation needs a separate flagged commit and independent checks on the pinned and upgraded versions. Added coverage must appear in the final test inventory. For repeated Baseline titles, every invocation must pass before and after, and the number of invocations must match.

`rankFeatureMatches.ts` verifies cited source locations. Direct replacements with a release quotation connecting the used symbol to the replacement rank first, followed by the number of distinct affected locations. Ties use dependency, source path, line, feature and release source. Only one adoption is attempted per upgrade. A declined match retains its source and disposition.

`confirmCheck.ts` compares repeat failures to the Baseline and retains the evidence for an untested check.

An Agent Attempt may add a test file beside a discovered suite with the same filename convention. Final verification must discover its named cases and see them pass.

A confirmed install failure can enter repair after a clean observation. The supervisor records the intended manifests and verifies the lockfile target before the first commit can qualify for a Patch.

`testInventorySummary.ts` reads current and historical test counts and test file errors. The web report and evaluation grader use the same schema.

`modelRequestSandbox.ts` defines model request sandbox options and serializes lazy allocation. `runtimeUsage.ts` measures each allocation through acknowledged deletion and combines runtime upper bounds with model receipts. Incomplete cleanup retains every unresolved identity on the Inspection error.

`readPrompt.ts` validates each Inspection’s bundled or caller-supplied Markdown and identifies effective templates by name, version and SHA-256. `buildPrompt.ts` fences bounded, redacted evidence at call time. `traceGeneration.ts` adapts an optional caller-owned tracer to the SDK’s per-call interface.

`inspectUpgrade.ts` runs the Install Check, confirms new failures and compares each Upgrade Check against the Baseline.
