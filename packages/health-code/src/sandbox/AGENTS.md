# Production sandbox provider

`createSandboxProvider.ts` owns the production SDK client, authenticated availability probe, runtime allocation, network policy readback, and deletion. It installs the project, observation, inference and patch bundles from the npm tarball. `requestRuntime.ts` applies operation budgets, captures bounded output, and translates SDK errors.

`provision.ts` prepares the disposable VM, installs tools, and acquires pinned source. It enables Linux memory overcommit so tools can reserve sparse virtual address ranges. `createSandboxProvider.ts` sets the physical memory limit at allocation.

`executeGuest.ts` constructs the guest filesystem, process, environment, and installation observation boundaries. Verify changes with the shared provider contract and the two pinned public fixtures using `bun run test:provider` from the repository root.

A hosted consumer passes a stable deployment name to the provider factory and calls the public `reconcileSandboxes` operation before starting workers. The provider paginates runtime inventory, matches its reserved prefix and Inspection UUID, and reclaims abandoned allocations by runtime ID. Ordinary CLI allocations retain their existing names.

`setCredentialBinding.ts` implements the revision-checked runtime PATCH used by CLI 0.2.19. `openCredentialSession.ts` verifies the full allowlist, authentication and revocation. Only the isolated model process may use the binding. Repository commands resume after verified removal and registry-only policy.

`executeTests.ts` exposes a fresh reporter file to the test process. The supervisor saves the reconciled inventory after that process exits and mounts the snapshot read-only for inventory queries.

The provider reads the runtime revision, sends `PATCH /v2/runtimes/{id}?expected_revision={revision}` and checks the complete replacement `secret_configuration`. Before releasing the repository it also waits for the gateway to reject the inert credential. The manual `bun run test:credential` contract sends the same one-token request before attachment, while attached and after removal.

`executeCommand.ts` accounts for active repository commands, collects observations and releases superseded test captures.

`createModelRequestSandbox.ts` creates the separate 1-vCPU, 512-MiB model request sandbox with closed egress. It reads back the one-host policy and attaches the revision-checked credential. `sandboxModelRequest.ts` sends one tool-free request through the trusted image’s curl with JSON on stdin. No checkout or provisioner enters this runtime. The deployment reaper matches the Inspection UUID and its exact model request sandbox sibling.

`projectFiles.ts` validates relative project paths and bounds reads and writes through the unprivileged guest process.
