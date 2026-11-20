# Inspection library

This workspace owns inspections, the Sandbox Provider, Ecosystem Adapter, prompts, and the evidence an Inspection produces. Use domain-model when naming library concepts.

`package.json` reserves the public name `health-code`. It exposes no modules yet. Add the public entry to its exports map with the first implementation. Both apps import the bare package name. Keep check implementations and provider-specific details inside the library.

`tsconfig.json` extends the shared strict Node-compatible configuration. Keep Bun-specific tooling in the root scripts. Unit tests use the fake provider. Store recorded evidence under a `fixtures/recorded` directory alongside its tests.
