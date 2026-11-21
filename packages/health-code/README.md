# Health Code

Health Code runs the repository’s test script, including its unit tests, in a Runta sandbox before and after an upgrade. If the repository has no test script, the Inspection Report marks that check as untested. With repair configured, it attempts a patch for a confirmed regression and verifies that patch in a fresh checkout. The library returns the checks, verdicts and verified patches in an Inspection Report.

```sh
npm install health-code
```

```js
import { createSandboxProvider, inspectRepository } from "health-code"

const report = await inspectRepository({
  repositoryUrl: "https://github.com/sindresorhus/ky",
  sandboxProvider: createSandboxProvider({ token: process.env.RUNTA_TOKEN }),
  limits: { maxUpgrades: 1 },
})
console.log(report.repository.commit, report.upgrades)
```

Supply model roles through the public options to enable model-assisted inspections. Use `onEvent` to follow progress and `revision` to pin a full Git commit SHA. The caller owns storage and delivery.

Registry lookup has its own three-minute timeout. Set `limits.timeouts.registry` in milliseconds to override it. If package version information is unavailable, `selection.registryLookupIssue` explains the failure and the Inspection Report keeps upgrades found from successful lookups. If the sandbox command outlasts the host deadline, the inspection returns a partial Inspection Report and deletes the sandbox.

For the local MCP server, run `npx health-code mcp setup`. See the [project README](https://github.com/doubleoevan/health-code#mcp-setup) for account setup and supported Node releases.

Pass complete versioned Markdown templates in the optional `prompts` map. Each Inspection Report lists the name, version and SHA-256 of the prompts used. Its `promptVersions.model` list identifies distinct dispatched templates. Its `promptVersions.handoff` list identifies distinct templates used to prepare Patch instructions. Pass an OpenTelemetry `Tracer` in `telemetry` to record call timing, status and usage. Tracing is off by default.

MIT licensed.
