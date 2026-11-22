# Inspection tests

`providerContract.ts` defines the checks shared by the fake and production providers. `live.ts` adds two public projects at fixed commit IDs. The Nano ID Baseline must pass its test script, which exercises oxlint's sparse virtual memory allocation. Run the credentialed suite through the root `bun run test:provider` command.

`fixtures/recorded/` holds inert npm, pnpm, Bun, and Yarn project inputs and transcripts. Unit tests read fixtures locally and execute the fake provider. The root test command covers the library alongside the repository checks.

The legacy Bun fixture stores its exact lockfile bytes as Base64. The adapter test decodes them in a temporary project before invoking Bun.

`controls.test.ts` covers filesystem attribution through pnpm symlinks and the guest’s read-only system mount.

`agentControls.test.ts` checks budget admission, prompt isolation, test inventory and credential binding with fake inputs. `liveCredential.ts` performs the opt-in proof using a stored credential name.

`liveCredential.ts` uses the named stored Anthropic credential for one authenticated token. Run it separately with `bun run test:credential`. The offline suite covers reservations, prompt boundaries, release intervals, test edits and the fake credential lifecycle. `guestModel.test.ts` exercises both wire protocols. `usageMap.test.ts` checks pinned usage and installed bytes. `verifyPatches.test.ts` checks verdicts and ranked adoption with the in-memory project and simulated package manager in `replayPatch.ts`. `patchHistory.test.ts` replays mailboxes with Git.

`testInventory.test.ts` checks suite discovery and repeated case identities during final patch verification.

`modelRequestSandbox.test.ts` covers time and cost admission, fenced prompt parity and both HTTPS protocols. `modelRequestSandboxProvider.test.ts` exercises verified binding replacement, network readback and recovery by exact allocation name. The live MCP acceptance uses a packed stdio process with just the sandbox token.

`replayProjectChecks.ts` supplies recorded commands for inspection and recovery tests. `recoverInspection.test.ts` covers partial results, replacement runtimes and registry discovery.
