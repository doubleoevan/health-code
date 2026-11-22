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

The sandbox timeline counts distinct stored model credentials across roles. After project detection, the Runta provider also reports how many distinct repository environment variables it supplied as placeholders. Both counts omit names and values. Older reports can lack either measurement.

For the local MCP server, run `npx health-code mcp setup`. See the [project README](https://github.com/doubleoevan/health-code#mcp-setup) for account setup and supported Node releases.

Pass complete versioned Markdown templates in the optional `prompts` map. Each Inspection Report lists the name, version and SHA-256 of the prompts used. Its `promptVersions.model` list identifies distinct dispatched templates. Its `promptVersions.handoff` list identifies distinct templates used to prepare Patch instructions. Pass an OpenTelemetry `Tracer` in `telemetry` to record call timing, status and usage. Tracing is off by default.

MIT licensed.

If the sandbox becomes unavailable after checkout and network lockdown, the report records `stoppedReason` and preserves completed checks. Selected upgrades can have `coverage` of `partial` or `skipped`. A caller supplying model roles can pass `reuseUpgrade(repository, upgrade)` to look up a previously verified upgrade. Scope the lookup to the exact repository commit and inspection configuration. Return the original upgrade with `reusedFromInspectionId` identifying its report. The new run measures its own baseline and costs.

The engine completes each selected upgrade and its eligible feature adoption before starting the next upgrade from the pinned commit. After transient sandbox loss it can allocate one replacement once deletion is acknowledged and the original time and spend ceilings permit it. It rebuilds the baseline, carries completed results forward and checks untouched targets before retrying the interrupted upgrade. Both lifetimes appear in the same timeline.

Call `listUpgrades({ repositoryUrl, sandboxProvider, order })` to get all eligible dependency versions and their source-linked release features. Choose a target from `dependencies` and pass it to `getUpgrade({ repositoryUrl, sandboxProvider, models, revision: upgradeMenu.repository.commit, upgrade: target })`. Read the selected upgrade’s `patches`, verdict and checks from the returned inspection report. Pass `onEvent` to either function to display the rolling log. Each event carries its inspection ID, sequence and type. The caller supplies the Runta account and model configuration.

Use `mode: "listUpgrades"` or `mode: "inspectUpgrades"` with the lower-level `inspectRepository` call. The default is `inspectUpgrades`.

`readUpgradeFeatures(upgrade)` returns all feature entries identified in the collected release notes, with sources and affected workspaces. Consumers can paginate the returned `features` array.

A release feature describes what the dependency added. Each `CodeFeatureMatch` in `upgrade.featureMatches` links a release feature to source in the inspected repository. When a result comes from an earlier inspection, `reusedFromInspectionId` identifies that inspection.

If the upgrade installs and Health Code cannot verify all network connections or filesystem changes, the report identifies the missing activity. With no recorded installation finding, Health Code runs the tests and runs the typecheck when the baseline typecheck passed. The upgrade verdict stays Untested.
