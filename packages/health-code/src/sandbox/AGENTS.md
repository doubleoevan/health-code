# Sandbox providers

`createFakeSandboxProvider.ts` replays caller-supplied fixtures and `createFakeModelRequestSandbox.ts` serves its model requests. `networkPolicy.ts` owns the registry allowlist and the policy readback check. The rest of this folder is the production provider.

`createSandboxProvider.ts` owns the production SDK client, authenticated availability probe, runtime allocation, network policy readback, and deletion. Protected integrity requests return repository paths and lifecycle evidence in bounded pages within the 1 MiB command-output limit. Ordinary command output is limited to 64 KiB. It installs the project, observation, inference and patch bundles from the npm tarball. `requestRuntime.ts` applies operation budgets, captures bounded output, and translates SDK errors.

`packageManagerVersions.ts` lists each package manager's official npm package, bundled version with its archive hash, supported range and display name. It also holds the check for an exact version. `provision.ts` prepares the disposable VM, installs tools, and acquires inspected source. Its package manager install script replaces a bundled package manager with the version a repository declares. The script reads the release from the registry's record, rejects one that is unpublished, deprecated or under a day old, and verifies the archive's SHA-512 before unpacking it. The provider runs it as trusted setup under the registry-only policy, with every path built from the fixed package name and a validated version number. It enables Linux memory overcommit so tools can reserve sparse virtual address ranges. `createSandboxProvider.ts` sets the physical memory limit at allocation.

`buildGuestArguments.ts` constructs the guest filesystem, process, environment, and installation observation boundaries. Verify changes with the shared provider contract and the two public fixtures at fixed commits using `bun run test:provider` from the repository root.

A hosted consumer passes a stable deployment name to the provider factory and calls the public `reconcileSandboxes` operation before starting workers. The provider paginates runtime inventory, matches its reserved prefix and Inspection UUID, and reclaims abandoned allocations by runtime ID. Ordinary CLI allocations retain their existing names.

`setCredentialBinding.ts` implements the revision-checked runtime PATCH used by CLI 0.2.19. `openCredentialSession.ts` verifies the full allowlist, authentication and revocation. Only the isolated model process may use the binding. Repository commands resume after verified removal and registry-only policy.

`buildTestCommand.ts` exposes a fresh reporter file to the test process. The supervisor saves the reconciled inventory after that process exits and mounts the snapshot read-only for inventory queries.

The provider reads the runtime revision, sends `PATCH /v2/runtimes/{id}?expected_revision={revision}` and checks the complete replacement `secret_configuration`. Before releasing the repository it also waits for the gateway to reject the inert credential. The manual `bun run test:credential` contract sends the same one-token request before attachment, while attached and after removal.

`executeCommand.ts` accounts for active repository commands, collects observations and releases superseded test captures.

`createModelRequestSandbox.ts` creates the separate 1-vCPU, 512-MiB model request sandbox with closed egress. It reads back the one-host policy and attaches the revision-checked credential. `sendSandboxModelRequest.ts` sends one tool-free request through the trusted image’s curl with JSON on stdin. No checkout or provisioner enters this runtime. The deployment reaper matches the Inspection UUID and its exact model request sandbox sibling.

`projectFiles.ts` validates relative project paths and bounds reads and writes through the unprivileged guest process.
