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

Folders import in one direction: root, `models/`, `sandbox/`, `upgrades/`, `checks/` and `patches/`, then `inspection/`. The exception is the `ModelInspection` type, which `patches/` imports from `inspection/inspectModels.ts`. The file names below sit in these folders.

`index.ts` is the public library entry. `contracts.ts` owns the JSON report and event types, provider interface, typed errors and the error codes whose message names the next step. `openRepositoryRuntime.ts` owns repository runtime allocation, checkout, network lockdown and replacement admission. `inspectRepository.ts` owns one bounded recovery attempt and final cleanup. `inspectProject.ts` runs the Baseline and serial upgrade checks. `parseYaml.ts` parses untrusted YAML for every folder with the duplicate key check off, which keeps a large lockfile linear. `readOwnProperty.ts` reads an own property of parsed data for every folder. `readPackageFile.ts` lists the files the library reads from its own package at run time and is the only module that reads them, from disk or from the standalone executable's embedded copy. `bash scripts/check-structure.sh` rejects any other source file that uses `import.meta.url`. `readPackageFileDigests.ts` validates those files and returns their SHA-256 digests.

`readLockedDependencies.ts` turns manifest, lockfile and workspace declaration text into the locked dependencies and the declared package manager version. `readVersionLookup.ts` reads the locked versions from the text of an npm, pnpm, Bun or Yarn lockfile. `toDeclaredPackageManager.ts` reads the exact version that `packageManager`, `devEngines`, `engines` or `.bun-version` declares. The three read no file and start no process, so the Guest and the upgrade menu share them. `fetchRegistryVersions.ts` and `selectRegistryVersions.ts` look up and select registry versions for both. `readCommittedReleaseAge.ts` reads the minimum release age from committed configuration text.

`upgradeMenuContext.ts` builds an upgrade menu in the caller's process: it holds the call's deadline, emits the upgrade menu's Inspection Events and composes the readers below. `requestGithubApi.ts` sends bounded requests to GitHub's API origin only, follows redirects that stay there and maps rate limits to typed errors. `readRepositoryFiles.ts` resolves the commit, lists the tree and reads the manifests, the lockfile and the package manager configuration by blob ID inside the byte, workspace and request bounds. `checkUpgradeTarget.ts` holds the rule for an eligible dependency version and looks up and checks one named version for the Guest and the upgrade menu. `selectUpgradeTarget.ts` applies the rule to a named version in the sandbox. `installDeclaredPackageManager.ts` installs the package manager version the Repository declares before any Repository file runs and records which version wrote the lockfile. `../sandbox/packageManagerVersions.ts` lists each package manager's official package, bundled version, supported range and display name. `createFakeGithub.ts` serves a project's files in the shapes of GitHub's commit, repository, tree and blob responses and answers registry lookups, for tests of the upgrade menu. `forEachConcurrently.ts` bounds the registry lookups and the file reads in flight, and `toUtcTime.ts` formats the time in a rate limit or a target rejection.

The upgrade menu parses untrusted files outside the sandbox. Each parser is bounded and tested against untrusted input in `test/untrustedInput.test.ts`:

| Input | Parser | Cases covered |
| --- | --- | --- |
| Tree, manifests, `package-lock.json`, registry responses | `JSON.parse` | Deep nesting, a document that is not an object, `__proto__`, `constructor` and `toString` as names, paths and keys |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml`, modern Yarn lockfile, `.yarnrc.yml` | `yaml` | Deep nesting, alias expansion, prototype member names |
| Yarn 1 lockfile | `@yarnpkg/lockfile` | A 900 KB line, prototype member names |
| `bun.lock` | `JSON.parse` after `dropTrailingCommas` | A `__proto__` key in the workspace map |
| `bunfig.toml` | `smol-toml` | A file that does not parse |
| Workspace and exemption patterns | `path.matchesGlob` behind `isBoundedGlob.ts` | At most 256 patterns of 256 characters, two brace groups, 16 alternatives and two wildcards per path segment, timed on Bun and Node |

Every lookup into parsed data by an untrusted name goes through `readOwnProperty`. A parser that throws becomes the reason "Unreadable project file".

`checkProject.ts` drives the Node Ecosystem Adapter and compares check evidence. `parseRegistryVersions.ts` separates completed registry lookups from timeouts and explains failed lookups. `selectUpgrades.ts` orders registry targets. `collectEvents.ts` owns per-inspection deadlines, the default check limits, the `CheckTimeoutError` a check raises when its own limit ends first and callback delivery. It builds the event envelope and tracks each step for an Inspection and an upgrade menu. `redactSecrets.ts` masks secrets in text and in nested values before they reach an event, a prompt or a report. `hasSecret` reports whether redaction would change a text. `createFakeSandboxProvider.ts` replays caller-supplied fixtures. The `sandbox/` module owns the production provider.

Verify with the library tests and the root packed-package check. Keep the public entry usable in Node and Bun.

The public entry also exports Repository URL normalization and deployment-scoped startup cleanup. For the site and the CI command it exports `toReleaseAgeNotice`, `explainedErrorCodes`, `packageManagerDisplayNames`, `isExactVersion`, `toUpgradeMenuReport` and `createFakeGithub` with its `versions` option.

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

`listUpgrades.ts` exposes three operations. `listUpgrades` builds an upgrade menu without a sandbox, `resolveUpgrade` checks one named version the same way and `getUpgrade` tests one selected upgrade. Its `toUpgradeMenuReport` shapes an upgrade menu and its events as the Inspection Report of a sandbox listing. `readUpgradeFeatures.ts` extracts bounded, source-linked feature entries from release notes for a selected target. Set `mode: "listUpgrades"` on `inspectRepository` for the sandbox listing, which lists eligible upgrades and releases the sandbox before installation. Pass an exact `upgrade` and `revision` to test a selected target. The public `health-code` entry groups, searches and sorts eligible versions.

`requestHostModel.ts` dispatches summaries and feature matching. It omits release notes from the end until the prompt fits its route bound. `mergeTestInventory.ts` combines test inventory and command results. `isPackagePath.ts` checks whether a module path names a package or one of its subpaths.
