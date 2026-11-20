# Production sandbox provider

`createSandboxProvider.ts` owns the production SDK client, authenticated availability probe, runtime allocation, network policy readback, and deletion. It loads the two trusted guest bundles shipped in the npm tarball. `requestRuntime.ts` applies operation budgets, captures bounded output, and translates SDK errors.

`provision.ts` prepares the disposable VM, installs tools, and acquires pinned source. It enables Linux memory overcommit so tools can reserve sparse virtual address ranges. `createSandboxProvider.ts` sets the physical memory limit at allocation.

`executeGuest.ts` constructs the guest filesystem, process, environment, and installation observation boundaries. Verify changes with the shared provider contract and the two pinned public fixtures using `bun run test:provider` from the repository root.
