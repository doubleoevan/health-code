# Inspection tests

`providerContract.ts` defines the checks shared by the fake and production providers. `live.ts` adds two public projects at fixed commit IDs. The Nano ID Baseline must pass its test script, which exercises oxlint's sparse virtual memory allocation. Run the credentialed suite through the root `bun run test:provider` command.

`readFixtureProject.ts` reads a recorded project as strings, shapes it as a repository for `../src/upgrades/createFakeGithub.ts` and holds the repository URL and the fixed time the upgrade menu tests share. The fake GitHub counts requests per origin and records any request to another origin. `upgradeMenu.test.ts` compares the upgrade menu with the locked dependencies on each recorded project and bounds a 200-dependency upgrade menu. `upgradeMenuOutcomes.test.ts` covers typed GitHub errors, limits, unreadable repositories and time bounds. `lockedDependencies.test.ts` and `releaseAge.test.ts` cover the locked dependencies, the declared package manager version and the minimum release age rules.

`upgradeTarget.test.ts` covers the rule for an eligible dependency version, `resolveUpgrade` and the sandbox's check of a named version. `declaredPackageManager.test.ts` covers the declared package manager install, its fallbacks and the install script's release check. `untrustedInput.test.ts` runs each parser against untrusted files and times the slowest accepted glob on Bun and Node. `live.ts` also compares the upgrade menu with the sandbox listing on both public fixtures and checks that the sandbox runs a declared Bun version. It installs the lowest supported version of each package manager through the package manager install path and runs the Guest's install, lockfile and configuration commands with it. The lowest versions come from `src/sandbox/packageManagerVersions.ts`.

`fixtures/recorded/` holds inert npm, pnpm, Bun, and Yarn project inputs and transcripts. `fixtures/recorded/npm/sandbox.json` records the sandbox commands for that npm project, and the developer CLI, the packed-package check and the CI command tests replay it. Unit tests read fixtures locally and execute the fake provider. The root test command covers the library alongside the repository checks.

The legacy Bun fixture stores its exact lockfile bytes as Base64. The adapter test decodes them in a temporary project before invoking Bun.

`controls.test.ts` covers network policy, guest environment and sandbox ownership. `inspectSandboxActivity.test.ts` covers network and filesystem attribution, including pnpm symlinks and the guest’s read-only system mount.

`agentControls.test.ts` checks budget admission, prompt isolation, test inventory and credential binding with fake inputs. `liveCredential.ts` performs the opt-in proof using a stored credential name.

`liveCredential.ts` uses the named stored Anthropic credential for one authenticated token. Run it separately with `bun run test:credential`. The offline suite covers reservations, prompt boundaries, release intervals, test edits and the fake credential lifecycle. `guestModel.test.ts` exercises both wire protocols. `usageMap.test.ts` checks inspected usage and installed bytes. `verifyPatches.test.ts` checks verdicts and ranked adoption with the in-memory project and simulated package manager in `replayPatch.ts`. `patchHistory.test.ts` replays mailboxes with Git.

`testInventory.test.ts` checks suite discovery and repeated case identities during final patch verification. `protectTestSupport.test.ts` covers protected test support files and mock edits.

`modelRequestSandbox.test.ts` covers time and cost admission, fenced prompt parity and both HTTPS protocols. `modelRequestSandboxProvider.test.ts` exercises verified binding replacement, network readback and recovery by exact allocation name.

`replayProjectChecks.ts` supplies recorded commands for inspection and recovery tests. `recoverInspection.test.ts` covers partial results, replacement runtimes and registry discovery.
