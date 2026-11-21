# Health Code

Health Code tests dependency upgrades in a Runta sandbox and returns a Report Card with verdicts, evidence and tested patches. The Node library accepts credentials and limits through its options object.

```sh
npm install health-code
```

```js
import { createSandboxProvider, inspectRepository } from "health-code"

const card = await inspectRepository({
  repositoryUrl: "https://github.com/sindresorhus/ky",
  sandboxProvider: createSandboxProvider({ token: process.env.RUNTA_TOKEN }),
  limits: { maxUpgrades: 1 },
})
console.log(card.repository.commit, card.upgrades)
```

Supply model roles through the public options to enable model-assisted inspections. Use `onEvent` to follow progress and `revision` to pin a full Git commit SHA. The caller owns storage and delivery.

For the local MCP server, run `npx health-code mcp setup`. See the [project README](https://github.com/doubleoevan/health-code#mcp-setup) for account setup and supported Node releases.

Pass complete versioned Markdown templates in the optional `prompts` map. Each Report Card lists the name, version and SHA-256 of the prompts used. Its `promptVersions.model` list identifies distinct dispatched templates. Its `promptVersions.handoff` list identifies distinct templates used to prepare Patch instructions. Pass an OpenTelemetry `Tracer` in `telemetry` to record call timing, status and usage. Tracing is off by default.

MIT licensed.
