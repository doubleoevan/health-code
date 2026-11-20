# Inspection engine

`index.ts` is the public library entry. `contracts.ts` owns the JSON report and event types, provider interface, and typed errors. `inspectRepository.ts` owns allocation, the pinned Baseline, candidate sequencing, and finally-block cleanup.

`checkProject.ts` drives the Node Ecosystem Adapter and compares check evidence. `selectUpgrades.ts` orders registry candidates. `collectEvents.ts` owns per-inspection deadlines and callback delivery. `createFakeSandboxProvider.ts` replays caller-supplied fixtures. The `sandbox/` module owns the production provider.

Verify with the library tests and the root packed-package check. Keep the public entry usable in Node and Bun.
