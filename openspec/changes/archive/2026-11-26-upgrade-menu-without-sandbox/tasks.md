# Tasks

Follow AGENTS.md and the skills its routing table names for each module: domain-model and code-style throughout, jsx-conventions, vercel-react-best-practices and web-design-guidelines in `apps/web/`, write-docs for prose. Run `bash scripts/preflight.sh` before handoff.

## 1. Shared locked dependencies

- [x] 1.1 Create `packages/health-code/src/upgrades/readLockedDependencies.ts` with `toWorkspaceDirectories` and `readLockedDependencies`, moved from `guest/readProjectFiles.ts` and `guest/detectProject.ts`. Both take file contents and touch no filesystem or process. Move `lockfiles`, `sections` and `Manifest` beside them if `bun run check:boundaries` rejects the import from `patches/`. Verify with unit tests that feed each recorded fixture's files as strings.
- [x] 1.2 Rewrite `guest/detectProject.ts` and `guest/readProjectFiles.ts` to read files from the checkout and call the shared functions. Keep the manager's running version, environment names, typecheck mode and test script in the Guest. Pass Bun's decoded text for `bun.lockb`. Verify the existing `nodeAdapter.test.ts` and `projectFiles.test.ts` pass unchanged.
- [x] 1.3 Move `guest/fetchRegistryVersions.ts` and `guest/selectRegistryVersions.ts` to `src/upgrades/`. Add the `registryConcurrency` and `maxRegistryResponseBytes` options with today's values as defaults. Verify `registry.test.ts` passes with only its import paths changed.
- [x] 1.4 Skip the dated lookup when the abbreviated response's `modified` time is before the age window, and fall back to it when `modified` is missing or invalid. Verify with a test that counts dated requests for one old and one recently modified package and compares the returned versions with the dated path.
- [x] 1.5 Add "Locked dependencies" to `.agents/skills/domain-model/SKILL.md`. Update `guest/AGENTS.md` and `src/AGENTS.md` for the moved files. Verify every path those guides name exists.

- [x] 1.6 Read the declared package manager version in `readLockedDependencies.ts` from `packageManager`, `devEngines.packageManager`, `engines` and `.bun-version`, in that order. Only an exact version is a declared version. Verify with a table test: each source, a range, two sources that disagree, a version declared for another package manager and hostile values with a URL, a path or shell characters.

## 2. GitHub reader and menu builder

- [x] 2.1 Record GitHub responses (commit, repository, tree, blobs) for each recorded fixture project under `packages/health-code/test/fixtures/` and write a `request` stub that serves them and counts requests per origin. Verify the stub rejects any URL outside `api.github.com` and `registry.npmjs.org`.
- [x] 2.2 Confirm against the live API that `GET /repos/{owner}/{repo}/commits/HEAD` with the SHA media type returns the default branch head. If it does not, resolve through `default_branch`. Verify by recording the response used in 2.1 and noting the result in `design.md` under "Verify during implementation".
- [x] 2.3 Create `src/upgrades/readRepositoryFiles.ts`: resolve the commit, check visibility when a token is supplied, read the recursive tree and read blobs by SHA. Use manual redirects limited to the API origin and four hops, the per-request and phase time bounds and the byte bounds from design decision 4. Skip symbolic links and submodules. Verify with tests for a renamed Repository, a truncated tree, a symbolic link, an oversized file and a redirect off the origin.
- [x] 2.4 Map GitHub outcomes to `InspectionError` codes with `retryAt`: private or missing Repository, unknown revision, rejected token, primary and secondary rate limits, unavailable API. Fail before file reads when `x-ratelimit-remaining` is below the reads needed. Verify with one recorded response per outcome and assert each message names a next step and no test output contains the token.
- [x] 2.5 Rewrite `listUpgrades` in `src/inspection/listUpgrades.ts` to compose the reader, the shared locked dependencies reader, the registry lookup, `selectUpgrades` and `toUpgradeMenu`. Return `unreadable` reasons and `packageManager.reason` as designed. Verify with the parity test: for the npm, pnpm, Bun, Yarn and modern Yarn fixtures the Guest reading and the GitHub reading return the same locked versions and skipped dependencies, and the binary Bun fixture returns `binary-lockfile`.
- [x] 2.6 Add the 200-dependency, 15-workspace offline test. Verify at most 22 GitHub requests, at most 200 registry requests and completion inside 5 seconds.
- [x] 2.7 Verify `listUpgrades` with `RUNTA_TOKEN` unset and a Sandbox Provider whose every method throws: the menu returns and no provider method is called. Add the partial registry lookup test.

## 3. Minimum release age

- [x] 3.1 Create `src/upgrades/readCommittedReleaseAge.ts` for npm, pnpm, Yarn and Bun per design decision 6, and call it from the Bun branch of `guest/readReleaseAge.ts`. Read only the release-age keys from `.npmrc`. Verify with a table test of one committed config per manager and with a `.npmrc` that also holds a registry and a token.
- [x] 3.2 Export the bundled package manager versions from `src/sandbox/provision.ts` and resolve the version the sandbox would run. Use the declared version from task 1.6 when it is an exact stable version inside the supported range, otherwise the bundled version. Verify with tests for a declared pnpm 11, a pnpm with no declared version, a declared version outside the range and Yarn with and without `yarnPath`.
- [x] 3.3 Build the default-by-version table. Read Yarn's changelog for the release that changed the `npmMinimalAgeGate` default and pnpm 10's documentation for the `.npmrc` key spelling, and record both sources in a comment on the table. Verify the table test covers the first version on each side of every change.
- [x] 3.4 Implement the assumed case: conflicting sources, an unparsable value and a version newer than the table. A range in `devEngines.packageManager` declares no version, so the bundled version's rule applies. Verify each returns at least 1,440 minutes with `isAssumed` and a cause.
- [x] 3.5 Add the Guest command that returns one version's status from the shared rule in task 9.1, using the package manager's own setting and the version's publish date, and call it in `NodeAdapter.listUpgrades` for a selected target. End a refused target as Untested with reason `minimum-release-age` before the Baseline. Verify with a fake-provider test that no install command or model request runs and the detail names the setting, the publish time and the eligible time.
- [x] 3.6 Confirm in the live suite whether npm 11.11.0 reports a date for `min-release-age` through `npm config get before`. Correct the Guest's npm branch if it does not. Verify by recording the result in `design.md` under "Verify during implementation".

## 4. Hostile input review

- [x] 4.1 Review each parser in the design's hostile-input table against its listed cases on Node and on Bun. Record one line per parser in `packages/health-code/src/AGENTS.md` naming the cases covered. Verify with one test per case: deep nesting, alias expansion, `__proto__` and `constructor` names, a `__proto__` key in `bun.lock`, long lockfile lines.
- [x] 4.2 Replace every lookup into parsed data by an untrusted name with an `Object.hasOwn` check and keep result maps on a null prototype. Verify the hostile-name tests list the dependency as skipped and `Object.prototype` is unchanged afterwards.
- [x] 4.3 Bound workspace and exclusion patterns to 256 patterns of 256 characters and time `path.matchesGlob` on nested-brace and repeated-wildcard patterns at those bounds under Node and Bun. Verify the slowest case finishes inside 100 ms or reject the pattern class that exceeds it.
- [x] 4.4 Verify a parser that throws, including a stack overflow, yields `packageManager.reason` and the process keeps running.

## 5. Public API, events and release

- [x] 5.1 Change the `listUpgrades` types in `src/inspection/listUpgrades.ts` and `src/index.ts` per design decision 1: remove `releaseFeatures`, add `packageManager`, `minimumReleaseAge` and `unreadable`, add `UpgradeMenuLimits`, mark the ignored options `@deprecated`. Add `retryAt` and `eligibleDependencyVersions` to `InspectionError`. Verify `bun run check:package` compiles a consumer that uses the new result and the deprecated options.
- [x] 5.2 Emit the menu's Inspection Events per design decision 2 with the existing envelope and the `detect` and `registry` labels. Verify with a test that replays the events through `apps/cli/src/toEventLine.ts` and finds no Sandbox Event.
- [x] 5.3 Change the stale-selection message in `src/checks/checkProject.ts` to name the dependency and say to refresh the Upgrade menu. Verify the existing rejection test asserts the new text and that nothing else matches the old string.
- [x] 5.4 Update `packages/health-code/README.md` and `GUIDE.md`: `listUpgrades` needs no Runta account, the new result fields, the typed errors, the bounds, the Minimum release age rule and the migration from `releaseFeatures` to `readUpgradeMenuFeatures`. Verify the README example runs as written against the recorded fixtures.
- [x] 5.5 Set the package version to 0.3.0. Verify `bash scripts/release-packages.sh --dry-run` builds the tarball.

## 6. CI command

- [x] 6.1 Read the GitHub token from `GITHUB_TOKEN` and otherwise `GH_TOKEN` in `apps/cli/src/readEnvironmentSettings.ts`. Verify with a test for each variable and for neither.
- [x] 6.2 In `apps/cli/src/checkRepository.ts`, with no named target build the menu before creating the Sandbox Provider, write `upgrade-menu.json` and test its first eligible target. Verify with the fake provider that one sandbox is allocated and the menu file is written. Task 9.4 covers a named target.
- [x] 6.3 Implement the no-eligible-upgrade cases from design decision 8. Verify exit 0 with a complete empty menu, exit 1 with an issue, and that the previous report and patches are removed in both.
- [x] 6.4 With no named target, fall back to the sandbox listing when the menu returns `unreadable` and log the reason. Verify with the binary Bun fixture and the fake provider.
- [x] 6.5 Add messages for the new error codes to `apps/cli/src/toFailureMessage.ts`. Verify each names a next step and the rate limit message names the reset time.
- [x] 6.6 Update `apps/cli/README.md`, `apps/cli/AGENTS.md` and the workflow examples in the root README and the CLI README: the menu is built on the CI machine, `GITHUB_TOKEN` or `GH_TOKEN`, `upgrade-menu.json` and the exit codes. Verify the workflow examples set a token the command reads.

## 7. Site storage, submission and limits

- [x] 7.1 Add the `upgrade_menus` table in `apps/web/src/server/storeUpgradeMenus.ts`, created if absent like the store's other additive tables, so the schema version stays at 3. Verify a menu saved by a sandbox listing still opens and its target can be selected (`upgradeMenu.test.ts`).
- [x] 7.2 Route `action: "discover"` to the menu path: resolve the head, check the `admissions` menu key and the `upgrade_menus` key, and insert the Inspection row and the menu row in one transaction. Return the winner's ID on a key conflict. Verify that discovery creates no admission, reservation or queue entry, that two simultaneous submissions get one ID, that a complete menu is reused inside the hour and an incomplete one is not.
- [x] 7.3 Add the three menu settings to the launch limits with defaults, and enforce the daily menu limit per visitor and network, the concurrency cap with its waiting list and the GitHub quota floor read from the site's own response headers. Treat a concurrency of zero as paused: saved menus open and the page offers the sandbox listing. Verify each refusal's status and message, the paused state, that a configuration without the settings loads, and that a saved menu opens during each refusal.
- [x] 7.4 Stop counting menus against the daily allowance, the header's count and `starts`. Verify the header's count is unchanged after a menu and drops after a selection, and that selection still goes through the challenge, the allowance and the reservation.
- [x] 7.5 Require `GITHUB_TOKEN` in production in `createLiveSource.ts`. Verify the production boot test fails without it with a message that names the setting, and that replay boots with no credentials.

## 8. Site worker, page, admin and docs

- [x] 8.1 Run each menu build in its own Bun process that the server kills when the build ends, passes its 45-second bound or passes its memory limit (first built as a `Worker`, revised after the ship security audit). The server appends the process's events and saves the result. Pass the site's bounds from design decision 4. Verify the worker loads the library and reports a typed failure, and that a build stubbed to never finish ends at its bound while the next build runs.
- [x] 8.2 Add the menu to the replay source so it serves the fixture menu with the menu's events and no GitHub request. Verify `upgradeMenu.test.ts` passes in replay with no credentials.
- [x] 8.3 Show the progress state on `/r/{id}` for a running menu without the Runta sandbox panel, queue position or stop control. Verify in the browser preview with replay that the page moves from "Finding upgrades..." to the menu, and with `discoverUpgrades.test.ts` that a menu's events carry no Sandbox Event.
- [x] 8.4 Show an `unreadable` menu's reason with the **List upgrades in a sandbox** button, wired to today's paid discovery path. Show the assumed Minimum release age line. Verify nothing is debited before the button is pressed and that pressing it reaches the challenge.
- [x] 8.5 Mark interrupted menu builds as failed at startup. Verify with a restart test that a menu left running fails with a message to request New features again.
- [x] 8.6 Add the fresh and reused menu columns to the admin page and count them in `launch_counts`. Verify with the admin cohort test for a day with ten fresh menus, five reused and three upgrade tests.
- [x] 8.7 Update `apps/web/AGENTS.md`, `apps/web/HOSTING.md`, and the root README's architecture diagram: the menu needs no Runta sandbox, production needs `GITHUB_TOKEN` as a fine-grained token with read-only access to public repositories and no other permission, the three menu settings with zero concurrency as the pause and what the allowance covers. Follow the customer copy voice. Verify every path and setting the guides name exists.

## 9. Any named version

- [x] 9.1 Create `src/upgrades/checkUpgradeTarget.ts`: one pure function that takes a package's registry record, the locked versions per workspace and the Minimum release age and returns the version's status, its kind and the eligible dependency versions. Add `"patch"` to `Upgrade.kind` in `src/contracts.ts`. Verify with a table test for each status: eligible patch, minor and major, unpublished, deprecated, prerelease, not newer, behind one workspace and too new.
- [x] 9.2 Add and export `resolveUpgrade` in `src/inspection/listUpgrades.ts`, built on the GitHub reader, the shared locked dependencies reader and one registry lookup. Throw `invalid-upgrade` with `eligibleDependencyVersions`, newest first and capped at 50. Verify offline that it allocates nothing, makes at most two registry requests and returns each reason's message, including a dependency no workspace declares.
- [x] 9.3 Replace the `selectUpgrades` validation of a selected target in `src/checks/checkProject.ts` with the status from the Guest command in task 3.5, and accept a target without `from`. Verify with the fake provider that a patch release is tested, that each rejected status stops before the Baseline and that a target without `from` uses the checkout's locked versions.
- [x] 9.4 In `apps/cli/src/checkRepository.ts`, resolve a named version with `resolveUpgrade` before creating the Sandbox Provider and print the newest ten eligible versions with the count of the rest on rejection. For an `unreadable` project pass the target without `from` to one sandbox. Verify with the fake provider: one sandbox for an eligible patch release, none for each rejected reason, one for the binary Bun fixture.
- [x] 9.5 Check every reader of `Upgrade.kind` for the new value: `selectUpgrades.ts`, `toUpgradeMenu.ts`, `apps/web/src/client/UpgradeMenu.tsx`, the report views and the pull request text. Verify a version 2 Inspection Report with a `patch` Upgrade renders on the site's report page and that a menu never contains one.
- [x] 9.6 Document named versions in `packages/health-code/README.md`, `GUIDE.md` and `apps/cli/README.md`: the five conditions, the `patch` kind, `resolveUpgrade` and the rejection message. Verify the documented `check` command for a patch release runs against the recorded fixtures.

## 10. The Repository's package manager version

- [x] 10.1 Add `.bun-version` to the files the GitHub reader requests for a Bun project. Verify the declared version from task 1.6 reaches `listUpgrades` and `resolveUpgrade` results and that the 200-dependency test still makes at most 22 GitHub requests.
- [x] 10.2 Declare the official package and the supported range for each package manager beside the bundled versions in `src/sandbox/provision.ts`. Establish each floor by running the provider contract at that version in the live suite. Verify by recording the floors and the contract result in a comment on the table and in `design.md` under "Verify during implementation".
- [x] 10.3 Add the optional `installPackageManager` operation to `SandboxProvider` in `src/contracts.ts` and implement it in `createSandboxProvider.ts`: read the version's integrity, deprecation and publish time from `registry.npmjs.org`, download from the URL built from the fixed package name and version, verify SHA-512 and any `packageManager` hash, then install as a setup step outside the Repository command sandbox. Verify with the fake provider and unit tests for an integrity mismatch, a deprecated version, a release under one day old, a failed download and a provider without the operation: each falls back to the bundled version with its reason.
- [x] 10.4 Add the Guest command that reads the declared version with file reads only, and call the install between the network lock and detection in `src/inspection/`. Emit a step named for the package manager and version. Verify with the fake provider that the install precedes every Repository command and that detection reports the installed version.
- [x] 10.5 Add `source`, `declared` and `fallbackReason` to the Inspection Report's `packageManager` in `src/contracts.ts`, and add the lockfile line to the pull request description in `apps/cli/src/openPullRequest.ts`. Verify a report written before the change still parses on the site and in the CI command, and that the pull request test asserts both sentences.
- [x] 10.6 Extend the provider contract and the live suite: a Bun project that declares a version other than the bundled one gets its Baseline install and its Upgrade's lockfile from the declared version. Record the added setup time. Verify with `bun run test:provider`.
- [x] 10.7 Document the sources of the declared version, the five trust conditions, the fallback and the report fields in `GUIDE.md`, `src/sandbox/AGENTS.md`, `guest/AGENTS.md` and `apps/cli/README.md`. Verify every path the guides name exists.

## 11. Upgrade only

- [x] 11.1 In `src/inspection/inspectModels.ts`, skip the Code Feature Match request and reserve nothing for Feature adoption when `limits.maxFeatureMatches` is 0. Verify with the offline model tests that usage lists the release summary and the repair only, that the reserved upper bound holds no adoption attempt and that the default limit behaves as before.
- [x] 11.2 Add `--upgrade-only` to `apps/cli/src/checkRepository.ts` and its usage line, passing `limits.maxFeatureMatches: 0`. Verify with the fake provider that the output holds the report and at most the upgrade Patch, alone and with `--pull-request`.
- [x] 11.3 Document `--upgrade-only` and the changed meaning of `maxFeatureMatches: 0` in `apps/cli/README.md` and `GUIDE.md`. Add a workflow example for a red Renovate pull request that passes the pull request's base commit as `--revision`, the package and version Renovate chose, `--upgrade-only` and `--pull-request`. Verify the example's command line parses with `readCheckArguments`.

## 12. Integration and measurement

- [x] 12.1 Extend `packages/health-code/test/live.ts`: on both public fixtures the menu equals the sandbox listing at the same commit, eligible targets and skipped dependencies. Record the menu's wall time. Verify with `bun run test:provider`.
- [x] 12.2 Run `bash scripts/preflight.sh` and `bun run check:package`. Verify both pass.
- [x] 12.3 Measure the abbreviated and dated registry response sizes of the largest common packages, then build the largest allowed menu from recorded worst-case responses in the worker while an event stream is open. Verify resident memory rises by at most 200 MB and each event arrives within one second. Set the site's registry caps from the result. The common packages did not fit: the result and the `HEALTH_CODE_MAX_MENU_RESPONSE_MIB` setting are recorded in `apps/web/HOSTING.md`.
- [x] 12.4 Build a monorepo-sized menu (shadcn-ui/ui, 100 dependencies with targets) on a container limited to 0.2 vCPU and 512 MB. Verify it completes inside the 45-second bound and record the time in `apps/web/HOSTING.md`.
- [x] 12.5 Walk the hosted journey in replay and against one public Repository: New features, the menu, a selection through the challenge, and New features at the daily Inspection limit. Verify the menu shows no Sandbox Event and the selection shows them.
- [x] 12.6 Confirm rollback needs no migration: the schema version stays at 3 and the new table is created if absent, so the previous image starts against the same database.
- [x] 12.7 Run the CarlNotes job end to end: `check --dependency --to --revision --upgrade-only`. No public fixture both declares Bun and has a failing patch release, so two runs cover it. This Repository at 0.2.2 verified one sandbox and the declared Bun 1.4.4 in the report. `runta-dev/errand` with `react` 19.2.9 verified a repair attempt and no Code Feature Match or Feature adoption usage.

## Workflow follow-up

- Run `/ship` and complete its review.
- Archive the change with the OpenSpec CLI.
- Commit the implementation and the archive together on `main` after explicit approval, then push with separate approval.
- Create the read-only public-repository token and set it as `GITHUB_TOKEN` in the hosted configuration before deploying.
