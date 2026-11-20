# Inspection tests

`providerContract.ts` defines the checks shared by the fake and production providers. `live.ts` adds two public projects at fixed commit IDs. Run the credentialed suite through the root `bun run test:provider` command.

`fixtures/recorded/` holds inert npm, pnpm, Bun, and Yarn project inputs and transcripts. Unit tests read fixtures locally and execute the fake provider. The root test command covers the library alongside the repository checks.

The legacy Bun fixture stores its exact lockfile bytes as Base64. The adapter test decodes them in a temporary project before invoking Bun.

`controls.test.ts` covers filesystem attribution through pnpm symlinks and the guest’s read-only system mount.
