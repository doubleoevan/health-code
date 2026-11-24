# Library guide

Start with the [README](README.md) for installation and a first inspection. This guide covers every option and report field.

The default sandbox provider reads `RUNTA_TOKEN`. Pass `sandboxProvider: createSandboxProvider({ token })` to set the token or memory. Supply model roles through the public options to enable model-assisted inspections. Use `onEvent` to follow progress and `revision` to pin a full Git commit SHA. The caller owns storage and delivery.

Registry lookup has its own three-minute timeout. Set `limits.timeouts.registry` in milliseconds to override it. If package version information is unavailable, `selection.registryLookupIssue` explains the failure and the Inspection Report keeps upgrades found from successful lookups. If the sandbox command outlasts the host deadline, the inspection returns a partial Inspection Report and deletes the sandbox.

The sandbox timeline counts distinct stored model credentials across roles. After project detection, the Runta provider also reports how many distinct repository environment variables it supplied as placeholders. Both counts omit names and values. Older reports can lack either measurement.

For the local MCP server, run `npx health-code mcp setup`. See the [MCP guide](https://github.com/doubleoevan/health-code/blob/main/apps/mcp/README.md#setup) for account setup and supported Node releases.

Pass complete versioned Markdown templates in the optional `prompts` map. Each Inspection Report lists the name, version and SHA-256 of the prompts used. Its `promptVersions.model` list identifies distinct dispatched templates. Its `promptVersions.handoff` list identifies distinct templates used to prepare Patch instructions. Pass an OpenTelemetry `Tracer` in `telemetry` to record call timing, status and usage. Tracing is off by default.

If the sandbox becomes unavailable after checkout and network lockdown, the report records `stoppedReason` and preserves completed checks. Selected upgrades can have `coverage` of `partial` or `skipped`. A caller supplying model roles can pass `reuseUpgrade(repository, upgrade)` to look up a previously verified upgrade. Scope the lookup to the exact repository commit and inspection configuration. Return the original upgrade with `reusedFromInspectionId` identifying its report. The new run measures its own baseline and costs.

The engine completes each selected upgrade and its eligible feature adoption before starting the next upgrade from the inspected commit. After transient sandbox loss it can allocate one replacement once deletion is acknowledged and the original time and spend ceilings permit it. It rebuilds the baseline, carries completed results forward and checks untouched targets before retrying the interrupted upgrade. Both lifetimes appear in the same timeline.

Call `listUpgrades({ repositoryUrl, order })` to get all eligible dependency versions and their source-linked release features. Choose a target from `dependencies` and pass it to `getUpgrade({ repositoryUrl, models, revision: upgradeMenu.repository.commit, upgrade: target })`. Read the selected upgrade’s `patches`, verdict and checks from the returned inspection report. Pass `onEvent` to either function to display the rolling log. Each event carries its inspection ID, sequence and type. The caller supplies the Runta account and model configuration.

Use `mode: "listUpgrades"` or `mode: "inspectUpgrades"` with the lower-level `inspectRepository` call. The default is `inspectUpgrades`.

`readUpgradeFeatures(upgrade)` returns all feature entries identified in the collected release notes, with sources and affected workspaces. Consumers can paginate the returned `features` array.

A release feature describes what the dependency added. Each `CodeFeatureMatch` in `upgrade.featureMatches` links a release feature to source in the inspected repository. When a result comes from an earlier inspection, `reusedFromInspectionId` identifies that inspection.

If the upgrade installs and Health Code cannot verify all network connections or filesystem changes, the report identifies the missing activity. With no recorded installation finding, Health Code runs the tests and runs the typecheck when the baseline typecheck passed. The upgrade verdict stays Untested.

Repository commands receive placeholder values for the environment variables they name. Pass `applicationEnvironment: { SCAN_BUDGET_USD: "5" }` to supply non-secret values for checks that need a number or URL. Other names keep their placeholders. Never pass a secret here: repository code can read and print it.

## Results and limits

Use `createSandboxProvider().checkAvailability()` to check a credential without allocating a sandbox. `SandboxUnavailableError` identifies authentication, permission and availability errors. Other fatal inspection errors carry the event timeline and any unresolved cleanup identifier. Health Code checks each upgrade from the inspected commit. After transient sandbox loss it can start one replacement within the original time and spend limits. It repeats the baseline, preserves completed upgrades and gives untouched targets a turn before retrying the interrupted one. A partial report shows where work stopped. If the original typecheck fails, Health Code can still compare the upgrade’s install and tests.

The Node adapter supports npm, pnpm, Bun and Yarn workspaces. It selects stable minor and major upgrades and confirms new failures against the Baseline. Consumers can highlight Sandbox Events in a live log or replay them from the report timeline.

Read each upgrade's `install.status` for the install command's Check Result. Its `observation.findings` list records off-registry connections, connection attempts with an unknown destination hostname and writes outside the project. Check `observation.complete` alongside that list. Even an empty list leaves the Upgrade Check untested when coverage is incomplete.

If an install script fails after trying to reach a blocked host, Health Code reinstalls without scripts. It uses that policy for every later install and sets `installScriptsSkipped` on the Check Result.

## Inspections with models

Pass configured model handles in `models.releaseSummary` and `models.featureMatch`. Give each a caller-owned pricing bound in USD per million input and output tokens and a maximum input token count. For `models.repair` and `models.featureAdoption`, supply the protocol, HTTPS base URL, model ID, pricing and a stored credential name with its header and value template. The library verifies the scoped binding inside the sandbox. Each returned Patch includes its tested commit, mailbox and application instructions.

An Inspection with models defaults to 60 minutes and $15. Repair gets up to 40 turns, 20 minutes and $4. Feature adoption gets up to 25 turns, 10 minutes and $2. Each agent turn allows up to 8,192 output tokens. Set a lower turn limit with `limits.agent.repair.maxTurns` or `limits.agent.featureAdoption.maxTurns`. Set total spending and time under `limits`. Existing model-free calls and legacy string dictionaries return version 1.

Use `readModelRoutes(environment)` to build routes from the `HEALTH_CODE_MODEL` settings. `health-code mcp setup` stores the key under the Runta secret these routes name. Pass a route and key to `createHostModel` for the summary and matching handles. Both accept Anthropic and OpenAI-compatible hosts. A caller can use the same configured model for summaries and matching. The guest route carries the stored credential name. The two model handles stay in the calling process.

```ts
import { inspectRepository } from "health-code"

const report = await inspectRepository({ repositoryUrl, models })
```

The public type for a version 2 Inspection Report is `InspectionReportV2`. A **Direct replacement** cites release text connecting the feature to its **Source location**. An **Inferred replacement** records the evidence available. The report also identifies **Affected call sites** and the **Adoption outcome** for each match.

A **Final patch check** produces **Patch verification**. **Download patch** provides the Git mailbox. **Applies to commit**, **Tested commit** and **Required upgrade patch** identify how to apply it. Each entry under **Dependency changes** identifies the reviewed commit. **Why repair stopped** gives the recorded diagnosis. **Installed size change** reports the difference in bytes.

**Model cost** uses recorded token usage and the caller’s pricing. **Reserved upper bound** shows the amount retained for a request whose receipt is missing. **Output tokens** reports measured reply tokens.

The **Test file errors** list (`testFileErrors`) records the file and reason for each load, setup or other runner error outside a named case. Named test failures and skips have their own counts.

Library callers can select `callerModelExecution: "modelRequestSandbox"` and pass stored-credential routes for all four roles. Omitting the option keeps summaries and Code Feature Matches in the caller’s process. A model request sandbox starts on the first eligible request. Each model request sandbox call has up to 120 seconds within the Inspection’s remaining work time. The Inspection Report records runtime cost bounds separately from model charges. `runtimeUsage.usageAsOf` gives the time through which runtime usage was measured.
