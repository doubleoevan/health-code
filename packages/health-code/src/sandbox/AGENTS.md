# Production sandbox provider

`createSandboxProvider.ts` owns the production SDK client, authenticated availability probe, runtime allocation, network policy readback, and deletion. It loads the two trusted guest bundles shipped in the npm tarball. `requestRuntime.ts` applies operation budgets, captures bounded output, and translates SDK errors.

`provision.ts` installs tools and acquires pinned source during setup. `executeGuest.ts` constructs the guest filesystem, process, environment, and installation observation boundaries. Verify changes with the shared provider contract and the two pinned public fixtures using `bun run test:provider` from the repository root.
