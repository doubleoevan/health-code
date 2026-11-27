# Proposal

## Why

Listing upgrades executes no Repository code, yet `listUpgrades` allocates a sandbox today. It calls `inspectRepository` in the `listUpgrades` mode, which checks sandbox availability, creates a repository sandbox, checks out the commit, locks the network, runs the Guest's `detect` and `registry` commands and deletes the sandbox. Four costs follow:

- Browsing needs `RUNTA_TOKEN`.
- A visitor waits for sandbox setup before the first result.
- The site spends an 8 GiB sandbox, a worker slot, a budget hold and one of the visitor's ten daily Inspections on every fresh Upgrade menu.
- `health-code check` allocates two repository sandboxes when the caller names a target: one to list and one to test.

GitHub and the npm registry can answer what can be upgraded. The sandbox is needed only for what is untrusted: installs, checks and Agent Attempts.

CarlNotes will call `health-code check` from GitHub Actions when a Renovate pull request for one package is red. Three gaps block that job. Renovate picks its own version, and the command accepts only the Upgrade menu's newest minor and newest major. CarlNotes declares Bun 1.4.4, and the sandbox writes the lockfile with its bundled Bun 1.4.3. The job wants a repair, and the command also spends on Feature adoption.

## What Changes

- **Library.** `listUpgrades` builds the Upgrade menu in the caller's process from GitHub's API and the public npm registry. It uses no Sandbox Provider, no `RUNTA_TOKEN` and no model. It never clones, never executes Repository code and never runs a package manager. The menu keeps its meaning: the inspected commit, stable minor and major targets that advance every declaring workspace, deprecated releases excluded, the Minimum release age honored, unsupported or unresolved sources listed as skipped and a partial registry lookup returned with its issue.
- **BREAKING.** `listUpgrades` no longer returns `releaseFeatures` on each target. Callers read them for the choices on screen with `readUpgradeMenuFeatures`. The package releases as 0.3.0. The design lists the options that `listUpgrades` now ignores and marks deprecated.
- **One reader for both sides.** The logic that turns manifests, the lockfile and workspace declarations into locked versions per workspace moves out of the Guest into one module that takes file contents and returns the locked dependencies. The Guest feeds it from the checkout. The menu feeds it from GitHub. The registry lookup and version selection are shared the same way. A parity test compares both sides on the recorded npm, pnpm, Bun and Yarn fixtures.
- **Minimum release age without a package manager.** The menu reads the setting from the committed config files and the package manager version the sandbox would run. It reports when it had to assume a value. The sandbox stays the authority: a selected target that the sandbox's package manager would refuse as too new ends as Untested with that reason before the Baseline or an Agent Attempt spends anything.
- **Untrusted input outside the sandbox.** The tree listing, every file and every registry response are bounded and parsed as hostile data. Repository content never chooses a request URL. The GitHub token goes to GitHub's API origin only.
- **Typed outcomes.** A private or missing Repository, an unknown revision, a GitHub rate limit and a project that cannot be read without executing something each produce a typed error or a typed reason that says what to do next. `listUpgrades` never allocates on its own.
- **`getUpgrade`.** The contract stays: one repository sandbox at the menu's commit. The rejection for locked versions that differ from the target gains a message that says to refresh the Upgrade menu.
- **CI command.** `health-code check` builds the Upgrade menu on the CI machine before it allocates anything, validates a named target against it and tests the target in one repository sandbox. It reads `GITHUB_TOKEN` and falls back to `GH_TOKEN`. It writes the menu to the output folder.
- **Site.** New features builds the menu in the server with no sandbox, worker slot, reservation or demo call. The daily allowance and the header's count cover upgrade tests only. Menu building gets its own protection: a limit per visitor and network, one shared lookup per Repository and commit, a cap on concurrent builds and a floor on remaining GitHub quota. Builds run off the thread that serves live event streams. Production requires `GITHUB_TOKEN`. The admin view counts fresh and reused menus per day.
- **Any named version.** `health-code check --dependency --to` and `getUpgrade` accept any stable published version above the installed one that passes the Minimum release age and advances every declaring workspace, patch releases included. The Upgrade menu keeps its picks. A version that is unpublished, deprecated, a prerelease, not newer or too new fails before any sandbox, and the message names the versions the command accepts. `Upgrade.kind` gains `"patch"`.
- **The Repository's own package manager version.** The sandbox installs the package manager version the Repository declares in `packageManager`, `engines` or `.bun-version`, in place of the bundled one, so the Patch's lockfile is written by the version the Repository's frozen install uses. The download is verified before any Repository-controlled file executes. The sandbox falls back to the bundled version when the Repository declares none or its declared version cannot be installed. The Inspection Report and the pull request description say which version wrote the lockfile.
- **Upgrade only.** `health-code check --upgrade-only` skips Code Feature Matches and Feature adoption, so a job that fixes a red pull request spends only on the repair and returns only the upgrade Patch.
- **Launch safety.** The site's GitHub token is limited to public repositories, read-only. Setting the menu concurrency to zero pauses fresh menus without a deploy. If the largest common packages do not fit in 512 MB, the container moves to 1 GB.
- **Docs.** The README's architecture diagram, both guides, the web and Guest module guides and `HOSTING.md` say what needs a Runta account (testing an Upgrade) and what does not (the Upgrade menu).

Unpinned inspections, the Baseline, the checks, the agents, Patches and the Inspection Report stay as they are, apart from importing the shared modules.

## Capabilities

### New Capabilities

- `upgrade-menus`: Building an Upgrade menu from GitHub and the npm registry in the caller's process. Covers GitHub access and its request budget, the bounds on input, hostile-input handling, the typed reasons a project cannot be read, the Minimum release age without a package manager and the events a menu emits.

### Modified Capabilities

- `upgrade-inspection`: `listUpgrades` returns the menu without a Sandbox Provider and without release features. `getUpgrade` says to refresh the menu when locked versions differ and ends a target the package manager refuses as too new as Untested. A named version is resolved without a sandbox, and any eligible published version can be the target.
- `node-ecosystem`: The Guest and the menu read the locked dependencies, registry versions and version selection through the same modules. The same module reads the declared package manager version.
- `ci-inspections`: `health-code check` validates a named version before allocating, uses one repository sandbox for it, reads `GITHUB_TOKEN` or `GH_TOKEN`, writes the menu when no target is named and defines the result when no upgrade is eligible. It gains `--upgrade-only`. The pull request states the package manager version that wrote the lockfile.
- `sandbox-execution`: The sandbox installs a trusted, verified package manager version that the Repository declares.
- `agent-attempts`: A caller that allows no feature matches gets no Code Feature Match request and no Feature adoption.
- `inspection-contract`: The Inspection Report records the package manager version that wrote the lockfile and where it came from.
- `hosted-inspections`: Menus are free and unqueued. The allowance covers upgrade tests only. Menu building has its own limits and cache. A repository the menu cannot read is listed in a sandbox under the paid rules.
- `launch-operations`: Production requires `GITHUB_TOKEN`. The admin view counts fresh and reused menus. The menu limits are operator settings.
- `package-releases`: The README and guides state which operations need a Runta account.

## Impact

- **Library** (`packages/health-code/`): `src/inspection/listUpgrades.ts`, new shared modules under `src/upgrades/`, `guest/detectProject.ts`, `guest/readProjectFiles.ts`, `guest/readReleaseAge.ts`, `guest/project.ts`, `src/checks/checkProject.ts`, `src/contracts.ts`, `src/index.ts`, the README, `GUIDE.md` and the module guides. `guest/fetchRegistryVersions.ts` and `guest/selectRegistryVersions.ts` move to `src/upgrades/`. No new dependency: the parsers (`yaml`, `@yarnpkg/lockfile`, `jsonc-parser`, `smol-toml`, `semver`) already ship as runtime dependencies.
- **Public API**: 0.3.0. `listUpgrades` options and result change. A new `resolveUpgrade` export validates one named version. `Upgrade.kind` gains `"patch"`. `getUpgrade` accepts a target without `from`. The Sandbox Provider interface gains one optional operation. The Inspection Report's `packageManager` gains fields.
- **Sandbox** (`packages/health-code/src/sandbox/`): `provision.ts` and `createSandboxProvider.ts` install a declared package manager version after checkout. `createFakeSandboxProvider.ts` records the request.
- **CI command** (`apps/cli/`): `checkRepository.ts`, `openPullRequest.ts`, `readEnvironmentSettings.ts`, `toFailureMessage.ts`, the README and the workflow examples, including one for a red Renovate pull request.
- **Site** (`apps/web/`): submission, admission, storage (one new table, schema version 4), a worker for menu builds, the report page's progress state, the admin page, `AGENTS.md` and `HOSTING.md`.
- **Operations**: production boot fails without `GITHUB_TOKEN`. Three new optional limit settings. A fresh menu costs GitHub REST requests against the site's token.
- **External services**: GitHub REST API (commit, tree, blobs) and `registry.npmjs.org` are now called from the caller's process and from the site's server.
