# Library guide

Start with the [README](README.md) for installation and a first inspection. This guide covers every option and report field.

The default sandbox provider reads `RUNTA_TOKEN`. Pass `sandboxProvider: createSandboxProvider({ token })` to set the token or memory. Supply model roles through the public options to enable model-assisted inspections. Use `onEvent` to follow progress and `revision` to inspect one full Git commit SHA. The caller owns storage and delivery.

Registry lookup has its own three-minute timeout. Set `limits.timeouts.registry` in milliseconds to override it. If package version information is unavailable, `selection.registryLookupIssue` explains the failure and the Inspection Report keeps upgrades found from successful lookups. If the sandbox command outlasts the host deadline, the inspection returns a partial Inspection Report and deletes the sandbox.

The sandbox timeline counts distinct stored model credentials across roles. After project detection, the Runta provider also reports how many distinct repository environment variables it supplied as placeholders. Both counts omit names and values. Older reports can lack either measurement.

For a CI job, run `npx health-code check`. See the [CI guide](https://github.com/doubleoevan/health-code/blob/main/apps/cli/README.md#setup) for account setup and supported Node releases.

Pass complete versioned Markdown templates in the optional `prompts` map. Each Inspection Report lists the name, version and SHA-256 of the prompts used. Its `promptVersions.model` list identifies distinct dispatched templates. Its `promptVersions.handoff` list identifies distinct templates used to prepare Patch instructions. Pass an OpenTelemetry `Tracer` in `telemetry` to record call timing, status and usage. Tracing is off by default.

If the sandbox becomes unavailable after checkout and network lockdown, the report records `stoppedReason` and preserves completed checks. Selected upgrades can have `coverage` of `partial` or `skipped`. A caller supplying model roles can pass `reuseUpgrade(repository, upgrade)` to look up a previously verified upgrade. Scope the lookup to the exact repository commit and inspection configuration. Return the original upgrade with `reusedFromInspectionId` identifying its report. The new run measures its own baseline and costs.

The engine completes each selected upgrade and its eligible feature adoption before starting the next upgrade from the inspected commit. After transient sandbox loss it can allocate one replacement once deletion is acknowledged and the original time and spend ceilings permit it. It rebuilds the baseline, carries completed results forward and checks untouched targets before retrying the interrupted upgrade. Both lifetimes appear in the same timeline.

## The upgrade menu

Call `listUpgrades({ repositoryUrl, order })` to get the eligible versions of every direct dependency at one commit. The call runs in your process. It reads the commit's file tree, manifests, lockfile and package manager configuration through GitHub's API and queries the public npm registry. It uses no Runta account, no sandbox and no model, never clones the repository and never runs a package manager. Testing a version is the step that needs a Runta account.

Choose a target from `dependencies` and pass it to `getUpgrade({ repositoryUrl, models, revision: upgradeMenu.repository.commit, upgrade: target })`. Read the selected upgrade’s `patches`, verdict and checks from the returned inspection report. Pass `onEvent` to either function to display the rolling log. Each event includes its inspection ID, sequence and type. An upgrade menu emits the `detect` and `registry` steps and no sandbox event.

| Result field | Meaning |
| --- | --- |
| `repository` | The URL and the commit that was read. Pass `revision` to choose the commit. |
| `packageManager` | The package manager and the version the sandbox would run, or `{ reason }` for an unsupported project. |
| `dependencies` | One entry per dependency with its newest eligible minor and major targets. |
| `skipped` | Dependencies that resolve from a source the registry does not serve. |
| `issue` | What a partial registry lookup left out, or why nothing could be listed. |
| `minimumReleaseAge` | The age that was applied, its exempt packages and the file or default it came from. `isAssumed` marks a value the upgrade menu could not read, and `source` then holds the reason. |
| `unreadable` | Why the committed files could not be read without a checkout: `binary-lockfile`, `tree-truncated`, `symbolic-link` or `limit`. The upgrade menu allocates nothing. Call `inspectRepository({ mode: "listUpgrades" })` to list in a sandbox. |

Read release features for the choices you show with `readUpgradeMenuFeatures(choices, { githubToken })`. `listUpgrades` reads none. To save an upgrade menu in the format of a sandbox listing, call `toUpgradeMenuReport(upgradeMenu, events)` with the events `onEvent` delivered.

**GitHub requests.** An upgrade menu costs one request for the commit, one for the tree, one per manifest, one for the lockfile and up to two for configuration files, plus one visibility check when you pass `githubToken`. A repository with 15 workspaces costs about 20. GitHub allows 60 requests an hour per address without a token, 1,000 per repository for the Actions token and 5,000 for a personal token. At the limit the call throws `github-rate-limit` with `retryAt` and does not retry. A token never reads a private repository: the call rejects it first.

**Typed errors.** A failure with no upgrade menu throws `InspectionError` with one of these codes: `invalid-repository`, `invalid-revision`, `repository-unavailable`, `revision-unavailable`, `github-rate-limit`, `github-token-rejected`, `github-unavailable`, `deadline`, `cancelled`, `menu-failed` or `event-delivery`. `event-delivery` means your `onEvent` callback threw. `explainedErrorCodes` holds the codes whose message names the next step, so a caller can show that message as it is.

**Bounds.** Set `limits` to lower them. A value above a bound returns `unreadable` with the reason `limit`.

| Limit | Default |
| --- | --- |
| `maxDurationMs` | 120,000. The GitHub reads share 30 seconds of it. |
| `maxWorkspaces` | 200 workspace manifests |
| `maxLockfileBytes` | 16 MiB |
| `maxTotalBytes` | 32 MiB for every file read |
| `registryConcurrency` | 16 lookups, or 4 when a minimum release age applies |
| `maxRegistryResponseBytes` | 32 MiB, or 48 MiB for a lookup with publish dates. A package above a lower value is listed under `skipped` with the limit. Parsing the largest responses takes about 400 MiB of memory. |
| `timeouts.registry` | 180,000 |

**Minimum release age.** The upgrade menu reads the setting from committed files: `.npmrc` for npm, `pnpm-workspace.yaml` (and `.npmrc` before pnpm 11) for pnpm, `.yarnrc.yml` for Yarn and `bunfig.toml` for Bun. A package manager's default applies when the file sets nothing: one day from pnpm 11 and from Yarn 4.15. When two files disagree, a value does not parse or the version is newer than the upgrade menu knows, the upgrade menu assumes one day, or the larger value it read, and sets `isAssumed`. `toReleaseAgeNotice(minimumReleaseAge)` returns the sentence that tells a reader so. The sandbox stays the authority: `getUpgrade` ends a version the package manager would reject as too new as Untested with the reason `minimum-release-age`, before anything installs.

**A named version.** `resolveUpgrade({ repositoryUrl, dependency, to })` validates one version in your process and returns its `upgrade`. A version is eligible when the registry lists it, it is not deprecated, it is not a prerelease, it is above the highest version the repository locks and it passes the minimum release age. Patch releases qualify and have the kind `patch`. A rejected version throws `invalid-upgrade` with `eligibleDependencyVersions`, newest first. `getUpgrade` applies the same rule in the sandbox. Omit `from` to use the checkout's locked versions.

**Deprecated on `listUpgrades`.** `sandboxProvider`, `prompts`, `telemetry`, `includeTestInventory`, `applicationEnvironment`, `callerModelExecution`, `limits.maxUpgrades`, `limits.maxCostUsd` and every `limits.timeouts` stage except `registry` are accepted and ignored. They are removed in 0.4.0.

## The package manager version

The sandbox installs the package manager version the repository declares, in place of its bundled one, so a patch's lockfile is written by the version the repository's frozen install uses. The declared version is the first exact version in `packageManager`, `devEngines.packageManager`, `engines` and, for Bun, `.bun-version`. A range declares no version.

A declared version is installed only when all of these hold. The library maps each package manager to its official npm package and the repository supplies only the version number. The version is inside the supported range. The registry lists it, it is not deprecated and it was published at least one day ago. The downloaded archive matches the integrity the registry records, and the hash in `packageManager` when there is one. Otherwise the bundled version runs.

`report.packageManager` records `version`, the version that ran, with `source` (`declared` or `bundled`), `declared` (the version and its file) and `fallbackReason`. `packageManagerDisplayNames` maps each package manager to the name to show, and `isExactVersion` checks that a version is three plain numbers.

Use `mode: "listUpgrades"` or `mode: "inspectUpgrades"` with the lower-level `inspectRepository` call. The default is `inspectUpgrades`.

Set `limits.maxFeatureMatches` to `0` to test the upgrade only. The engine then sends no Code Feature Match request and runs no Feature adoption. It still summarizes the release notes, which the repair reads. Before 0.3.0 a zero limit still returned ranked matches.

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

Use `readModelRoutes(environment)` to build routes from the `HEALTH_CODE_MODEL` settings. `health-code setup` stores the key under the Runta secret these routes name. Pass a route and key to `createHostModel` for the summary and matching handles. Both accept Anthropic and OpenAI-compatible hosts. `HEALTH_CODE_MODEL_HOST` uses `/v1` unless it includes another API path. A caller can use the same configured model for summaries and matching. The guest route carries the stored credential name. The two model handles stay in the calling process.

```ts
import { inspectRepository } from "health-code"

const report = await inspectRepository({ repositoryUrl, models })
```

The public type for a version 2 Inspection Report is `InspectionReportV2`. A **Direct replacement** cites release text connecting the feature to its **Source location**. An **Inferred replacement** records the evidence available. The report also identifies **Affected call sites** and the **Adoption outcome** for each match.

A **Final patch check** produces **Patch verification**. **Download patch** provides the Git mailbox. **Applies to commit**, **Tested commit** and **Required upgrade patch** identify how to apply it. Each entry under **Dependency changes** identifies the reviewed commit. **Why repair stopped** gives the recorded diagnosis. **Installed size change** reports the difference in bytes.

**Model cost** uses recorded token usage and the caller’s pricing. **Reserved upper bound** shows the amount retained for a request whose receipt is missing. **Output tokens** reports measured reply tokens.

The **Test file errors** list (`testFileErrors`) records the file and reason for each load, setup or other runner error outside a named case. Named test failures and skips have their own counts.

Library callers can select `callerModelExecution: "modelRequestSandbox"` and pass stored-credential routes for all four roles. Omitting the option keeps summaries and Code Feature Matches in the caller’s process. A model request sandbox starts on the first eligible request. Each model request sandbox call has up to 120 seconds within the Inspection’s remaining work time. The Inspection Report records runtime cost bounds separately from model charges. `runtimeUsage.usageAsOf` gives the time through which runtime usage was measured.
