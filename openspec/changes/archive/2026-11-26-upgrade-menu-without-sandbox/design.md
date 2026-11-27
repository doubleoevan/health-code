# Design

This design records eleven decisions. They were approved before any code changed, the implementation has run, and decision 7 was revised during the ship review, which needs approval again. Decisions 1 to 8 cover the Upgrade menu. Decisions 9 to 11 cover the three additions for a red Renovate pull request: any named version, the Repository's own package manager version and upgrade only. Each decision below states the choice, the reason and the alternative it rejects. Section "Verify during implementation" lists the facts the research could not confirm and what the implementation found. None of them changes the approach.

## Context

See `proposal.md` for the motivation. The facts below shape the approach.

**Library today.** `listUpgrades` (`src/inspection/listUpgrades.ts`) calls `inspectRepository({ mode: "listUpgrades" })`, then reads release features for every target. The Guest (`guest/detectProject.ts`, `guest/readProjectFiles.ts`) walks the checkout, picks the package manager from the root lockfile, expands workspace declarations and resolves each direct dependency to its locked version per workspace. `guest/fetchRegistryVersions.ts` queries `registry.npmjs.org` with `redirect: "error"`. `guest/readReleaseAge.ts` runs `npm|pnpm|yarn config get` and parses `bunfig.toml`. The host then calls `selectUpgrades`.

**The sandbox runs declared package managers.** `src/sandbox/provision.ts` installs npm 11.11.0, pnpm 10.19.0, Yarn 1.22.22, Yarn 4.9.2 and Bun 1.4.3. It does not use Corepack. Two managers can replace themselves from committed input: pnpm 10 downloads the version in `packageManager` (`managePackageManagerVersions` defaults to true) and Yarn runs the binary named by `yarnPath`.

**Site today.** A New features request is a full hosted Inspection: `LaunchService.admit` resolves the head, runs Turnstile, debits one of ten daily Inspections, holds `maxCostUsd` against the daily budget, enqueues and takes a worker slot. The worker allocates an 8 GiB sandbox. The menu is saved as an ordinary `inspections` row whose card carries `upgradeMenu`. Its cache key lives on the `admissions` row. The site runs as one Bun process with no worker threads. Server-sent events come from that process with a 15-second heartbeat and a 60-second idle timeout. The site loads release features per visible target through `readUpgradeFeatures`.

**CI command today.** With a named target, `checkRepository.ts` runs one sandbox listing and then one sandbox test. Without one it runs a single unpinned inspection with `maxUpgrades: 1`.

**Selected targets today.** `NodeAdapter.listUpgrades` validates a selected target with `selectUpgrades`, so it accepts only a newer stable minor or major version. `Upgrade.kind` is `"minor" | "major"`. The target must carry `from`.

**Provisioning today.** `prepareRepository` runs `provision()` before checkout. Each bundled tool is downloaded from `registry.npmjs.org` and checked against a SHA-512 hash written in the library source. The network is locked to the registries after checkout.

**Model roles today.** Each tested Upgrade requests a release summary, then Code Feature Matches, then runs repair when a check fails and Feature adoption for ranked matches. The repair prompt reads the release summary (`attemptUpgrade.ts`). `limits.maxFeatureMatches` (default 3) bounds adoptions. At 0 the engine still requests the matches.

**GitHub limits** (REST documentation, read 2026-11-26). Anonymous requests: 60 per hour per IP address. Personal token: 5,000 per hour. `GITHUB_TOKEN` in Actions: 1,000 per hour per repository. A limit answers 403 or 429 with `x-ratelimit-remaining: 0` and `x-ratelimit-reset`, or with `retry-after` for a secondary limit. The documentation says not to retry before that time. A recursive tree holds at most 100,000 entries or 7 MB and sets `truncated` above that. A blob read supports 100 MB. GraphQL has no anonymous tier.

## Goals / Non-Goals

**Goals:**

- `listUpgrades` returns the same eligible targets and skipped dependencies as the sandbox listing at the same commit, with no Sandbox Provider.
- One implementation of detection, registry lookup and version selection serves the Guest and the menu.
- A hostile Repository cannot make the menu request an arbitrary URL, leak a token, exhaust memory or block the site's event streams.
- A sandbox is allocated only to test an Upgrade, or to list a repository the menu cannot read.
- A CI job can test the exact version another tool chose, with the package manager version its Repository declares, and pay only for the repair.

**Non-Goals:**

- Changing unpinned inspections, the Baseline, the checks, the agents, Patches or the Inspection Report.
- Private repositories, GitHub Enterprise hosts or registries other than `registry.npmjs.org`.
- Walking a truncated tree directory by directory. See decision 5.
- Batching file reads through GraphQL. See decision 3.
- A `health-code list` command. See decision 8.
- Offering patch releases in the Upgrade menu.
- Resolving a version range in `engines` to a package manager version, and installing a declared Node version. See decision 10.

## Decisions for approval

### 1. Public API

`listUpgrades` and `getUpgrade` stay the two public calls. The package releases as **0.3.0**.

```ts
listUpgrades(options: {
  repositoryUrl: string
  revision?: string                  // full commit SHA. Default: the default branch head
  order?: UpgradeMenuOrder
  search?: string
  githubToken?: string
  request?: typeof fetch             // unchanged injection point, used by offline tests
  limits?: UpgradeMenuLimits         // decision 4
  onEvent?: (event: InspectionEvent) => void | Promise<void>
  signal?: AbortSignal
}): Promise<{
  repository: { url: string; commit: string }
  packageManager: { name: PackageManager; version?: string } | { reason: string }
  dependencies: DependencyChoice[]   // targets carry no releaseFeatures
  skipped: string[]
  issue?: string
  minimumReleaseAge?: { minutes: number; excluded: string[]; source: string; isAssumed?: true }
  unreadable?: { reason: "binary-lockfile" | "tree-truncated" | "symbolic-link" | "limit"; message: string }
}>
```

| Today | After |
| --- | --- |
| `sandboxProvider` | Accepted, ignored and marked `@deprecated`. A test passes a provider whose every method throws. Removed in 0.4.0. |
| `limits` (`InspectionLimits`) | `maxDurationMs` and `timeouts.registry` keep their meaning. `maxUpgrades`, `maxCostUsd` and the other stage timeouts are ignored and deprecated on this call. The new bounds join the same object. |
| `onEvent` | Kept. See decision 2. |
| `prompts`, `telemetry`, `includeTestInventory`, `applicationEnvironment`, `callerModelExecution` | Accepted, ignored and marked `@deprecated` on this call. Removed in 0.4.0. |
| `dependencies[].targets[].releaseFeatures` | **Removed.** Call `readUpgradeMenuFeatures(visibleChoices, { githubToken })`. |
| `skipped` | Lists dependencies only. The Guest's environment-scan notes no longer appear in a menu. |
| `packageManager`, `minimumReleaseAge`, `unreadable` | New result fields. |

`resolveUpgrade` is a new export for decision 9. It takes the same options plus `dependency` and `to`, and returns `repository`, `packageManager`, `minimumReleaseAge` and either `upgrade` or `unreadable`. `Upgrade.kind` gains `"patch"`. `getUpgrade` accepts a target without `from` and then uses the checkout's locked versions.

`inspectRepository({ mode: "listUpgrades" })` stays and stays undeprecated. It is the sandbox listing that the fallback in decision 5 and the live parity test use. `getUpgrade` keeps its signature.

Failures with no menu throw `InspectionError` with these codes: `invalid-repository`, `invalid-revision`, `repository-unavailable`, `revision-unavailable`, `github-rate-limit`, `github-token-rejected`, `github-unavailable`, `deadline` and `cancelled`. `InspectionError` gains an optional `retryAt` timestamp, set for `github-rate-limit`, and an optional `eligibleDependencyVersions` list, set for `invalid-upgrade`.

*Why remove `releaseFeatures` instead of keeping it behind an option.* A 200-dependency menu has up to 400 targets. Reading features for each costs up to 400 release lookups against GitHub, which is what exhausts a shared CI address. The site already reads features per visible target. An opt-in flag would keep a second behavior to test for one release.

*Why 0.3.0.* The result type loses a field, so TypeScript callers that read it stop compiling. Under semantic versioning a 0.x minor carries breaking changes. The README and guide get a three-line migration note.

### 2. The menu emits Inspection Events

`listUpgrades` emits version 1 Inspection Events through `onEvent`: `inspection.started`, one `step.started` and `step.finished` pair for each of "Resolve commit" (omitted when `revision` is supplied), `detect` and `registry`, then `inspection.finished` with `inspected: 0`, or `inspection.failed` with the error code. The `detect` and `registry` labels match the sandbox listing, so the web timeline and the CI log line render them unchanged. The menu never emits a Sandbox Event.

*Why.* Three consumers already render these events: the developer CLI, `toEventLine` in the CI command and the site's timeline. The site's progress state in decision 7 reuses its existing stream and reloads on the terminal event. Returning without events would need a second progress mechanism on the site.

*Alternative rejected:* a new menu-specific event type. Exhaustive version 1 handlers in callers would stop compiling.

### 3. GitHub access

All requests go to `https://api.github.com` with an explicit `X-GitHub-Api-Version`. Owner and repository come from the validated Repository URL. Blob SHAs come from the tree and must match 40 hexadecimal characters. No path or URL comes from file content.

| Step | Request | When |
| --- | --- | --- |
| Commit | `GET /repos/{owner}/{repo}/commits/HEAD` with `Accept: application/vnd.github.sha` | `revision` omitted |
| Visibility | `GET /repos/{owner}/{repo}` | A token is supplied. The menu rejects a private Repository, so a token never reads one. |
| Tree | `GET /repos/{owner}/{repo}/git/trees/{commit}?recursive=1` | Always |
| Files | `GET /repos/{owner}/{repo}/git/blobs/{sha}` with the raw media type | Root manifest, each workspace manifest, the lockfile and the config files present in the tree: `pnpm-workspace.yaml`, `.npmrc`, `.yarnrc.yml`, `bunfig.toml`, `.bun-version` |

**Cost.** Requests = 1 commit (when `revision` is omitted) + 1 visibility (with a token) + 1 tree + 1 root manifest + W workspace manifests + 1 lockfile + C config files, where C is 0 to 2 for one package manager. A CarlNotes-sized Repository (15 workspace manifests) costs 19 to 21 requests without a token and 20 to 22 with one. The site supplies the head it already resolved, so its fresh menu costs 19 to 21 on top of the two requests its admission makes today.

| Caller | Limit | CarlNotes-sized menus per hour |
| --- | --- | --- |
| Anonymous | 60 per IP | 2 |
| `GITHUB_TOKEN` in Actions | 1,000 per repository | 45 |
| Personal token | 5,000 | 227 |

**At the limit.** Once the root manifest and the workspace declaration are read, the menu compares the last `x-ratelimit-remaining` with the file reads still to make. When they do not fit, or when GitHub answers 403 or 429 for a limit, the call throws `github-rate-limit` with `retryAt`. It does not retry. Without a token the message reads: "GitHub's limit for requests without a token is used up until 14:32 UTC. Set GITHUB_TOKEN or try again then." With one: "GitHub's limit for this token is used up until 14:32 UTC. Try again then." A 401 throws `github-token-rejected`.

**Redirects.** Requests use `redirect: "manual"` and follow at most four hops, each to `https://api.github.com` with no credentials in the URL, as `apps/web/src/server/verifyRepository.ts` does. This covers a renamed Repository. The `Authorization` header is sent to that origin only. The site keeps its own copy of the redirect check in `verifyRepository.ts`: exporting an HTTP helper from the inspection library to share 20 lines would widen the public entry.

**Outcomes.** A 404 on the commit or visibility request throws `repository-unavailable`. A 404 or 422 on the tree for a supplied `revision` throws `revision-unavailable`. Without a token the menu makes one extra `GET /repos/{owner}/{repo}` to tell a missing Repository from an unknown revision. Each message names the next step.

*Why REST blobs only.* One code path works with and without a token. A GraphQL query could read all manifests in one request, but it needs a token, truncates large blobs and adds a second reader to test. *Add it when* the site's quota floor in decision 7 pauses menus in practice.

*Alternatives rejected.* `raw.githubusercontent.com` is a second origin with undocumented limits. The tarball endpoint redirects to a third origin and downloads up to 100 MiB to read 20 files.

### 4. Bounds

| Bound | Library default | Site | Above the bound |
| --- | --- | --- | --- |
| Tree response body | 8 MiB | same | `unreadable: tree-truncated` |
| Tree entries outside ignored directories | 50,000, the Guest's file bound | same | `unreadable: limit` |
| Workspace manifests | 200 | 100 | `unreadable: limit` |
| Workspace patterns | 256 patterns of at most 256 characters | same | `packageManager.reason` "Unsupported workspace declaration" |
| One manifest | 1 MiB | same | `unreadable: limit` |
| One config file | 256 KiB | same | `unreadable: limit` |
| Lockfile | 16 MiB, the Guest's bound | 8 MiB | `unreadable: limit` |
| All Repository files | 32 MiB | 12 MiB | `unreadable: limit` |
| Concurrent GitHub file reads | 6 | same | Not applicable |
| One GitHub request | 10 s | same | `github-unavailable` |
| GitHub phase | 30 s | same | `deadline` |
| Whole call (`maxDurationMs`) | 120 s | 45 s | Registry phase: the menu returns what completed, with `issue` |
| Registry | Per request: 8 s and 32 MiB without publish dates, 20 s and 48 MiB with them. 16 or 4 in flight | 4 in flight and a 16 MiB cap on every response, until the measurement in Risks sets them | Per package: `issue` for a timeout, `skipped` for a response over the cap |

The menu checks the size GitHub reports for each tree entry before it requests the file, and enforces the same bound again while streaming the body. A `limit` message names the bound and the observed value: "This Repository has 312 workspace manifests. The Upgrade menu reads at most 200."

`UpgradeMenuLimits` exposes `maxDurationMs`, `maxWorkspaces`, `maxLockfileBytes`, `maxTotalBytes`, `registryConcurrency` and `maxRegistryResponseBytes`. The other rows are constants.

**The 200-dependency test.** An offline test builds a 200-dependency, 15-workspace menu from recorded responses. It asserts at most 22 GitHub requests, at most 200 registry requests and completion inside 5 seconds. Live timing is not known yet. The live suite records it for the public fixtures, and task 12.4 measures it on a 0.2 vCPU container.

### 5. Projects the menu cannot read

`listUpgrades` returns `unreadable` with a typed reason, an empty `dependencies` list and the same sentence in `issue`. It never allocates.

| Reason | Cause | Why a sandbox can read it |
| --- | --- | --- |
| `binary-lockfile` | The only Bun lockfile is `bun.lockb` | The Guest decodes it by running Bun |
| `tree-truncated` | GitHub truncated the recursive tree | The Guest walks the checkout |
| `symbolic-link` | The root manifest, the lockfile or a config file is a symbolic link | The Guest follows links that stay inside the checkout |
| `limit` | A bound in decision 4 | The Guest's bounds are higher than the site's |

The site and the CI command hold a Runta account. They fall back to `inspectRepository({ mode: "listUpgrades" })` under today's paid rules. The CI command falls back on its own and logs the reason. The site shows the reason with a **List upgrades in a sandbox** button, because the fallback debits one of the visitor's daily Inspections and runs Turnstile. A silent fallback would spend the allowance without the visitor choosing to.

*Alternative rejected:* reading a truncated tree one directory at a time. GitHub's documentation recommends it, but a `**` workspace pattern needs one request per directory. *Add it when* the admin view shows `tree-truncated` on more than a few menus per week.

An unsupported or ambiguous project is not `unreadable`. It returns `packageManager.reason` with today's text, and the site shows today's detection message.

### 6. Minimum release age without a package manager

The menu derives the setting from committed files and the package manager version the sandbox would run. Under decision 10 that version is the Repository's declared version when it is an exact stable version inside the supported range, otherwise the bundled version exported from `provision.ts`.

| Manager | Committed source | Default when unset |
| --- | --- | --- |
| npm | Root `.npmrc`: `before` (a date) wins, otherwise `min-release-age` in days. No other key in the file is read. | None |
| pnpm | `pnpm-workspace.yaml`: `minimumReleaseAge` in minutes and `minimumReleaseAgeExclude`. For pnpm below 11, also `minimum-release-age` in the root `.npmrc`. | pnpm 11 and later: 1,440 minutes. pnpm 10.16 to 10.x: 0. Earlier: unsupported. |
| Yarn | `.yarnrc.yml`: `npmMinimalAgeGate` (a bare number is minutes; suffixes `ms`, `s`, `m`, `h`, `d`, `w`) and `npmPreapprovedPackages`. | Below 4.10: unsupported, which covers the bundled 4.9.2 and Yarn 1. 4.10 to 4.14: none. 4.15 and later 4.x: 1,440 minutes. |
| Bun | `bunfig.toml`: `install.minimumReleaseAge` in seconds and `minimumReleaseAgeExcludes`. This is the file the Guest reads today. | None |

**The unknown case.** The menu cannot know the setting when two committed sources disagree, a value does not parse, or the declared version is newer than the table. A range in `devEngines.packageManager` declares no version (decision 10), so the sandbox runs the bundled version and the menu reads that version's rule. It then applies the larger of 1,440 minutes and any value it could parse, sets `minimumReleaseAge.isAssumed` and names the cause in `minimumReleaseAge.source`. The site and the CI log print one line: "The health inspector could not read this Repository's minimum release age and assumed one day."

*Why assume one day instead of none.* One day is the largest default any supported manager ships. A menu built with it offers only targets every candidate setting would install. Assuming none would offer targets the sandbox then refuses.

**The sandbox stays the authority.** When `getUpgrade` tests a selected target, the Guest checks that one version against the package manager's own setting, read as today through the config command, and the version's publish date. A refused target ends as Untested with the reason `minimum-release-age` and a detail that names the setting, the publish time and when the target becomes eligible. This happens after detection and before the Baseline, so no install, check or Agent Attempt runs.

**A cheaper lookup for both sides.** The shared registry lookup requests publish dates only when the abbreviated response's `modified` time is inside the age window. A package not modified within the window has no release that young. This returns the same versions and removes most 48 MiB lookups for a Repository with a one-day age, which is every pnpm 11 Repository. A missing or invalid `modified` falls back to the dated lookup.

### 7. Site

**Storage and identity.** A menu stays an `inspections` row with an ID from the same generator, a choice of `{ mode: "listUpgrades", revision }`, a card with `upgradeMenu` and a `/r/{id}` page. Selection, the Tested patch available filter, pre-change menus and every existing link read the same shape. A new table holds what `admissions` held for menus, with no money:

`upgrade_menus(id PRIMARY KEY, cacheKey UNIQUE, visitor, network, day)`

The cache key is `[repositoryId, revision, libraryVersion, deployment SHA, "menu"]`. The unique key gives one shared lookup per Repository and commit: a second submission receives the first one's ID. A complete menu is reused for one hour. An incomplete menu clears its key on finish, as today. An `unreadable` menu and an unsupported project are complete answers for their commit. The lookup checks the existing `admissions` menu key first, so a sandbox-listed menu from the fallback is reused under today's rule. The table is created if absent, as the store already does for its other additive tables, so the schema version stays at 3 and the previous image starts against the same database.

**Request and page.** The submission returns 202 with `Location: /r/{id}` and does not wait for the menu. The page shows a short progress state: the "Finding upgrades..." heading and the step lines, with no Runta sandbox panel, queue position or stop control. It reloads into the menu on the terminal event, as today. The build ends by its 45-second bound.

*Why not hold the request.* The estimate for a CarlNotes-sized menu on 0.2 vCPU is 10 to 20 seconds, and task 12.4 measures it. A held request of that length invites a second click and gives a joining visitor nothing to watch.

**What a menu no longer touches.** No admission row, hold, queue entry, worker slot, Turnstile challenge, license lookup or daily Inspection. `Starts` in the admin view stops counting menus. The header's count covers upgrade tests and sandbox listings.

**Protection.** Three optional settings join the operator limits that refresh from Doppler. Each has a default, so the current configuration stays valid.

| Setting | Default | Effect at the limit |
| --- | --- | --- |
| `HEALTH_CODE_DAILY_MENU_LIMIT` | 30 | Fresh menus per UTC day, counted per visitor and per network like the Inspection allowance. 429: "You have listed upgrades for 30 repositories today. The limit resets at 00:00 UTC. Saved upgrade menus stay open." |
| `HEALTH_CODE_MENU_CONCURRENCY` | 1 | Menu builds in flight. Up to eight more wait in memory. Beyond that, 429: "The upgrade menu is busy. Try again in a minute." Zero pauses fresh menus: saved menus stay open and the page offers the sandbox listing from decision 5. |
| `HEALTH_CODE_GITHUB_QUOTA_FLOOR` | 500 | Fresh menus pause while the site's remaining GitHub requests are below the floor. The site reads the count from the headers of its own GitHub responses. 503: "New upgrade menus are paused until 14:32 UTC. Saved upgrade menus stay open." |

A reused menu passes none of these checks. The floor keeps 500 requests for admission, verification and license lookups of paid Inspections.

*Why a pause setting.* A new endpoint that needs no sign-in should be switchable off without a deploy. The limit refresh delivers the setting within a minute.

**No Turnstile on a menu.** The challenge guards paid work. A menu spends no money, and the three limits bound what a script can take: menu capacity for one network, never the Inspection budget and never the last 500 GitHub requests. Selecting a target keeps the challenge. *Add it when* the admin view shows the busy or floor responses on normal days.

**Off the path of live streams, and out of the server's memory.** Parsing blocks a thread: a multi-megabyte `pnpm-lock.yaml` parses for seconds on 0.2 vCPU. Each menu build runs in its own Bun process (`upgradeMenuProcess.ts`). The server sends the request over the process channel and receives events and the result. It never parses Repository or registry bytes. The server kills the process when the build ends, passes its 45-second bound plus a 5-second grace, or holds more memory than `HEALTH_CODE_MAX_MENU_MEMORY_MIB` (default 320). The process starts with an empty environment, so the only secret it holds is the GitHub token in its request. It tells its collector the memory limit and asks the kernel to end it before the server when the container runs out of memory. A build that passes the memory limit publishes the `limit` reason, which offers the sandbox listing.

*Revised on 2026-11-26 after the ship security audit.* The first design ran each build in a Bun `Worker` and rejected a child process for its memory cost. The audit measured three things that reverse that choice. An 8 MiB `pnpm-lock.yaml` of short list items reached 2.3 GiB in the worker, which shares the server's memory, so one free submission could end every running paid Inspection. `Worker.terminate()` did not stop a thread inside a long regular expression match. And a build process costs about 80 MiB before it reads anything, measured on macOS, which the 512 MB container holds.

Measured on 2026-11-26 on macOS at full speed, with the collector told its limit: a build for `shadcn-ui/ui` (a pnpm monorepo with 97 listed dependencies) peaked at 362 MiB with a 16 MiB response cap and 531 MiB with a 48 MiB cap. The earlier measurement in a 0.2 vCPU Linux container, where the collector runs more often per byte read, was a 218 MiB rise at 16 MiB and 413 MiB at 48 MiB. The default limit is 320 MiB, so that one build and about 150 MB for the server fit a 512 MB container. The macOS peak at the default cap passes it and is offered the sandbox listing. The Linux measurement fits. An event stream open during a build receives each event within one second, because the server only relays messages.

**Unchanged.** Selecting a target, paid admission at the menu's commit, the message when the head has moved, and the checks and messages for private, missing and oversized repositories. Replay mode serves the fixture menu with no credentials and no GitHub request. Production refuses to start without `GITHUB_TOKEN`.

**A token that can do nothing else.** The build process parses untrusted files with the token in memory. The hosted token is a fine-grained token limited to public repositories, read-only, with no account permissions, and nothing else uses it. A leak then exposes rate limit only. `HOSTING.md` states this.

**Admin view.** Two daily columns beside Inspections: fresh menus and reused menus. The share of menus that lead to an upgrade test is upgrade tests divided by fresh plus reused menus.

### 8. CI command

`health-code check` validates its settings, reads GitHub with `GITHUB_TOKEN` or else `GH_TOKEN` and only then creates the Sandbox Provider. With a named version it resolves that one target (decision 9) and builds no menu. With none it builds the menu and writes `upgrade-menu.json` to the output folder.

| Case | Sandboxes | Output | Exit code |
| --- | --- | --- | --- |
| Named version eligible | 1 | Inspection Report, patches | 0, or 1 for a partial report as today |
| Named version rejected | 0 | Nothing. The message names the reason and the eligible versions. | 1 |
| No named target | 1 | Menu, Inspection Report and patches for the menu's first target | 0, or 1 for a partial report |
| No eligible upgrade, menu complete | 0 | Menu. The folder's previous report and patches are removed. Message: "No eligible upgrade at {commit}." | 0 |
| No eligible upgrade, menu has an issue | 0 | Menu. The issue is printed. | 1 |
| Project that cannot be read, named version | 1 | The reason is logged. The sandbox validates the version. | As today |
| Project that cannot be read, no named target | Today's count | The reason is logged, then the command lists in a sandbox as today | As today |

*Why exit 0 with nothing to upgrade.* A scheduled job with nothing to do has succeeded. A registry issue means eligibility is unknown, so that case exits 1, matching the existing rule for a partial report.

**No `health-code list` command now.** `check` writes the menu for a pipeline to read. A `list` command would be the one command that runs without setup, with its own arguments, output format, docs and tests. *Add it when* someone asks to browse upgrades from a terminal without a Runta account.

The workflow examples already set `GH_TOKEN: ${{ github.token }}` for the pull request, and the command reads it when `GITHUB_TOKEN` is unset.

### 9. Any named version

**The rule.** A dependency version is eligible at a commit when all five hold: the registry lists it, it is not deprecated, it carries no prerelease tag, it is above the highest locked version among the declaring workspaces and it passes the Minimum release age. The dependency must resolve to the registry in every declaring workspace. Patch releases qualify. The Upgrade menu keeps its picks: the newest eligible minor and the newest eligible major.

**The Upgrade's kind for a patch release: `"patch"`.** `Upgrade.kind` becomes `"minor" | "major" | "patch"`. A patch release keeps the major and minor of the highest locked version. Menus never contain it, so the site's menu and its sort orders do not change.

*Alternatives rejected.* Labelling a patch release `"minor"` would put a false label in the Inspection Report and the pull request. Making `kind` optional would force every reader to handle a missing value. The union widens in 0.3.0, which already breaks the result type.

**Before any sandbox.** `resolveUpgrade` reads the locked dependencies through the same GitHub reader as the menu and looks up one package. It costs the menu's GitHub requests plus one or two registry requests, against one per dependency for a menu. It returns the Upgrade with its `from` versions and its kind. A rejected version throws `invalid-upgrade` with `eligibleDependencyVersions`, newest first and capped at 50. The CI command prints the newest ten and the count of the rest:

"react 19.3.1 was published 5 hours ago and this Repository's minimum release age is one day. It becomes eligible at 09:00 UTC on 27 November. Eligible versions: 19.3.0, 19.2.4, 19.2.3 and 12 older."

Each reason has its own first sentence: not published, deprecated, a prerelease, not newer than the installed version, too new, not a direct dependency, or resolved from a source the registry does not serve.

**In the sandbox.** `getUpgrade` applies the same rule through one shared function. The Guest command from decision 6 returns the version's status. An unpublished, deprecated, prerelease or not-newer version is rejected with `invalid-upgrade` before the Baseline. A version the package manager's own setting refuses as too new ends as Untested, as decision 6 states. When `from` is omitted the sandbox uses the checkout's locked versions, which is how the CI command tests a named version in a project `resolveUpgrade` cannot read.

**The site** selects from a saved menu and is unchanged.

### 10. The Repository's own package manager version

**The declared version.** The shared detection module reads it from committed files, in this order: `packageManager` in the root manifest, `devEngines.packageManager`, `engines.{manager}` and, for Bun, `.bun-version`. A declared version is one exact version. A range declares no version. A version declared for a different package manager than the lockfile selects is ignored. `.bun-version` joins the files the menu reads.

**What makes a version outside the bundled set trusted.** All five must hold:

1. **A fixed package.** The library maps each package manager to its official npm package: `npm`, `pnpm`, `yarn`, `@yarnpkg/cli-dist` and `@oven/bun-linux-x64`. The Repository supplies only a version number. It never supplies a package name or a URL.
2. **A supported version.** The version is exact, stable and inside a range `provision.ts` declares for that package manager. The range starts where the Guest's install, lockfile and config commands work, which task 10.2 establishes by running the provider contract at each floor.
3. **A settled release.** The registry lists the version, it is not deprecated and it was published at least one day ago.
4. **A verified download.** The archive's SHA-512 equals the integrity the registry records for that version. When `packageManager` carries a hash, the archive must match it too.
5. **Trusted setup.** The provider downloads from a URL built from the fixed package name and the version, verifies it and installs it as a setup step outside the Repository command sandbox, before any Repository-controlled file executes.

A declared version that fails any condition, or a download that fails, falls back to the bundled version. The report records why.

*Why registry integrity is enough.* The Repository can choose only among the official releases of its own package manager, and its own CI already runs the one it chose. The bundled hashes stay in the library source because the library picks those versions. The one-day floor covers a release that was compromised and withdrawn within hours.

*Alternatives rejected.* An allowlist of versions with hashes shipped in the library is stricter, but every new package manager release would wait for a Health Code release, and CarlNotes' next Bun bump would fall back to the bundled version. Trusting the hash in `packageManager` alone trusts a value the Repository wrote. Corepack does not install Bun.

**Order in the sandbox.** Checkout, network lock, read the declared version, install the declared version, then detect. The Guest reads the declared version with a command that only reads files. The install runs under the registry-only network policy through a new optional Sandbox Provider operation. A provider without it uses the bundled version. Detection then reports the version that runs.

**What the report says.** `packageManager` keeps `name` and `version`, the version that ran, and gains `source` (`"repository"` or `"bundled"`), `declared` (the version and the file it came from) and `fallbackReason`. A step named for the package manager and version appears in the timeline. The pull request description adds one line built from the fixed package manager name and the validated version: "Lockfile written by Bun 1.4.4, the version this repository declares." or "Lockfile written by Bun 1.4.3, bundled with Health Code, because 1.4.9 was published less than a day ago."

**The menu** uses the same rule for the declared version for the Minimum release age defaults in decision 6. It does not check the registry for the package manager's release, so it can differ from the sandbox for a declared version that is too new or deprecated. The sandbox check before the Baseline covers that case.

*Not included.* A range in `engines` is not resolved to a version: the bundled version runs, and the report notes when it falls outside the range. *Add it when* a Repository's install fails for that reason. Node stays at the bundled version.

**Cost.** One more download per tested Upgrade. In the live suite on 2026-11-26 the sandbox downloaded, verified and installed the declared Bun 1.4.4 in 4.3 seconds, in place of the bundled 1.4.3.

### 11. Upgrade only

**The flag is `--upgrade-only`.** It names what the job gets back: the upgrade Patch and nothing built on top of it.

*Alternatives rejected.* `--no-feature-adoption` names the mechanism and needs negated-flag parsing. `--repair-only` is wrong when the Upgrade passes as is and no repair runs.

**What still runs.**

| Role | With `--upgrade-only` | Why |
| --- | --- | --- |
| Release summary | Runs | The repair prompt reads it, and the report shows it. One bounded request per Upgrade. |
| Code Feature Match | Skipped | Its only consumers are Feature adoption and the report's matches. |
| Repair | Runs when a check fails | This is what the job pays for. |
| Feature adoption | Skipped | No feature change lands in a fix. |

**In the library** the flag sets the existing `limits.maxFeatureMatches` to 0. The engine changes in one place: at 0 it no longer sends the Code Feature Match request and reserves nothing for Feature adoption. The Inspection Report has an empty `featureMatches` list and at most the upgrade Patch. The pull request carries only that Patch. The `featureAdoption` model route stays required, so `getUpgrade`'s signature does not change.

This changes one existing behavior: a caller that already passes `maxFeatureMatches: 0` stops receiving ranked matches it never adopted. The guide states it.

## Further decisions

**One reader.** A new `src/upgrades/readLockedDependencies.ts` holds two pure functions. `toWorkspaceDirectories` takes the root manifest text, the `pnpm-workspace.yaml` text and the candidate manifest directories, and returns the declared workspaces. `readLockedDependencies` takes file contents by path and returns the package manager, its declared version, the locked version of each direct dependency per workspace and the skipped dependencies. The Guest reads the files from the checkout, calls both and adds what only testing needs: the manager's running version, environment variable names, the typecheck mode and the test script. For `bun.lockb` the Guest passes the text Bun decodes. The menu has no such text and returns `binary-lockfile`. `fetchRegistryVersions.ts` and `selectRegistryVersions.ts` move to `src/upgrades/` unchanged apart from the `modified` shortcut and the two new limits. Committed release-age parsing lives in `src/upgrades/readCommittedReleaseAge.ts`. The Bun branch of the Guest's reader calls it.

**Locked dependencies** joins the domain model: the locked version of each direct dependency per workspace, with the dependencies skipped for an unsupported or unresolved source.

**Hostile input.** The parsers now run in the site's server and in CI jobs. Task group 4 reviews each one and adds a test per case.

| Input | Parser | Reviewed for |
| --- | --- | --- |
| Tree, manifests, `package-lock.json`, registry responses | `JSON.parse` | Deep nesting that overflows the stack, `__proto__` and `constructor` as dependency names, workspace paths and lock keys |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml`, Yarn 2+ lockfile, `.yarnrc.yml` | `yaml` | Alias expansion, merge keys, `__proto__` keys, custom tags |
| Yarn 1 lockfile | `@yarnpkg/lockfile` | Prototype keys, tokenizer time on long lines |
| `bun.lock` | `JSON.parse` after a string-aware pass that drops trailing commas. `jsonc-parser` does not load as a Node ES module, which the packed library needs. | A `__proto__` key that sets an object's prototype, a comma inside a string |
| `bunfig.toml` | `smol-toml` | Prototype keys, deep tables |
| Workspace and exclusion patterns | `path.matchesGlob` | Matching time on nested braces and repeated wildcards, on Node and on Bun |
| Versions and ranges | `semver` | Length limits |

Every lookup into parsed data by an untrusted name uses `Object.hasOwn`. Result maps keep a null prototype. A parser that throws, including a stack overflow, yields `packageManager.reason`, never a crash. Tree entries with mode `120000` (symbolic link) or type `commit` (submodule) are skipped as the Guest skips links, and no workspace manifest is read through one. `.npmrc` is read for the release-age keys only: registry, proxy and credential keys are never parsed into a value. Tokens never appear in an error, an event or a log line. Registry redirects stay rejected.

**`getUpgrade`.** The rejection for locked versions that differ keeps its error type and gains the message: "The checkout locks {dependency} at a different version than the selected target. Refresh the Upgrade menu and select again."

## Verify during implementation

The research could not confirm the first four facts. Each had a task and changed a table row or a request, not the approach. The fifth records the end-to-end run.

1. **Confirmed on 2026-11-26.** `GET /repos/ai/nanoid/commits/HEAD` with the SHA media type answered 200 with the default branch head as plain text. An unknown commit on the tree endpoint answered 422, a missing Repository 404, and a blob read with the raw media type returned the file's text.
2. **Confirmed on 2026-11-26.** The live suite installed each range's lowest version through the package manager install path and ran the Guest's commands with it: change a dependency, install from the frozen lockfile, read the config, upgrade and resolve the lockfile. npm 10.0.0, pnpm 9.0.0, Bun 1.2.0, Yarn 1.22.0 and Yarn 4.0.0 all passed, so the ranges in `packageManagerVersions.ts` stand. The contract reads its floors from that table.
3. **Confirmed on 2026-11-26.** With `min-release-age=3` in `.npmrc`, npm 11.11.0 prints a date three days back for `npm config get before`. The Guest's npm branch already reads it.
4. **Yarn confirmed on 2026-11-26** from the `plugin-npm` source at each release tag: the setting is absent in 4.9.2, a number of minutes defaulting to 0 in 4.10.0 to 4.10.3, a duration defaulting to `0m` in 4.11.0 to 4.14.x and a duration defaulting to `1d` from 4.15.0. The pnpm 10 `.npmrc` key spelling is still unconfirmed, so the reader accepts `minimum-release-age` and `minimumReleaseAge`.

5. **Run on 2026-11-26.** `health-code check --dependency @opentelemetry/api --to 1.9.1 --revision <0.2.2 commit> --upgrade-only` against this Repository, which declares Bun 1.4.4 and whose menu offers only 1.10.0. The command resolved the patch version before any sandbox, used one repository sandbox, installed the declared Bun 1.4.4, recorded the Upgrade with the kind `patch` and the Verdict Passes as is, and returned one upgrade Patch. Model usage held the release summary only, at $0.024. Both runtimes were deleted. The Upgrade passed as is, so this run did not exercise a repair under `--upgrade-only`.
6. **Run on 2026-11-26.** `health-code check https://github.com/runta-dev/errand --dependency react --to 19.2.9 --revision a20b925 --upgrade-only`, a patch release whose tests fail until `react-dom` has the same version. The command recorded the kind `patch`, ran one repair attempt that moved `react-dom` to 19.2.9 and returned the Verdict Fixed with one Patch that changes `package.json` and `package-lock.json`. Model usage held the release summary and the repair only, at $0.235, with no Code Feature Match and no Feature adoption. The upper bound was $0.334 and both runtimes were deleted. This Repository uses npm, so the bundled npm 11.11.0 wrote the lockfile.

## Risks / Trade-offs

- [Large registry responses on a 512 MB container. A response with publish dates can reach 48 MiB and parses to several times that. Packages that publish nightly builds are both large and recently modified.] → **Measured on 2026-11-26.** The registry's summary of `next` is 24.6 MiB, and its dated records for `vite`, `next` and `typescript` are 37.2, 30.1 and 15.2 MiB. In a container limited to 0.2 vCPU, a menu for a 100-dependency pnpm monorepo with a two-day age took 25 seconds and 218 MiB at a 16 MiB cap, with `next`, `vite`, `playwright` and `@typescript-eslint/eslint-plugin` skipped. At the 48 MiB cap it listed everything in 30 seconds and 413 MiB. The main thread was delayed by at most 86 ms in every run. The common packages do not fit in 512 MB, so listing them needs the 1 GB container. `HEALTH_CODE_MAX_MENU_RESPONSE_MIB` defaults to 16, which is safe at 512 MB, and the operator raises it to 48 after resizing. The library's summary cap rose from 16 to 32 MiB, because `next` could not be listed at all before.
- [The menu and the sandbox disagree on the Minimum release age.] → The parity test on recorded fixtures, the live comparison on the public fixtures, the assumed-one-day rule and the sandbox check before the Baseline.
- [The menu reads a symbolic link or a file differently from the Guest.] → The `symbolic-link` reason sends those projects to the sandbox listing.
- [GitHub's API is down while a clone would work.] → The menu throws `github-unavailable`. There is no fallback: paid admission needs the same API.
- [A script drains menu capacity.] → The daily limit per network, the concurrency cap and the quota floor. The paid budget and the last 500 GitHub requests are out of reach.
- [The site keeps two discovery paths: the free menu and the sandbox listing fallback.] → The fallback is today's code, unchanged and covered by today's tests.
- [A Repository declares an old package manager version with a known flaw.] → The supported range has a floor, and the version runs inside the same sandbox controls as the bundled one.
- [A declared version behaves differently from the bundled one in the Guest's commands.] → The provider contract runs at each range floor and at the bundled version. A declared version outside the range falls back.
- [The registry serves a tampered archive together with matching integrity.] → The trust root for a declared version is the registry over TLS, which is the trust root of every install the sandbox runs. The bundled versions keep hashes fixed in the source.
- [The sandbox cannot reach the registry when it checks a selected version.] → The check is skipped and the Install Check decides, which fails for a version the registry does not serve. A caller that used `resolveUpgrade` has already applied the five conditions in its own process.
- [A free menu build exhausts the server's memory or its GitHub requests.] → Each build runs in its own process with a memory limit, the request floor is checked before any request and counts admitted builds, the parsers that read committed files are linear, and one project holds at most 10,000 declared dependencies.
- [A named patch release is tested although the menu never offered it.] → The same five conditions apply, and the sandbox applies them again.
- [A caller relied on ranked matches with `maxFeatureMatches: 0`.] → Stated in the guide and the 0.3.0 notes.
- [The change is named for the menu and now carries three additions for CI.] → The proposal lists them. The capabilities they touch have their own delta specs.
- [The menu's `skipped` list loses the Guest's environment-scan notes.] → They describe testing, not upgrades. An Inspection Report still records them.

## Migration Plan

1. Release the library as 0.3.0 with the migration note for `releaseFeatures`.
2. Create the read-only public-repository token and set it as `GITHUB_TOKEN` in the hosted configuration before deploying. The new image refuses to start without it.
3. Deploy. The server creates `upgrade_menus` if it is absent. Menus saved before the change open from their existing rows. Their cache keys include the old library version, so none is reused.
4. Rollback: redeploy the previous image. The schema version is unchanged and the extra table is ignored.
