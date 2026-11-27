## Why

A CarlNotes `@tanstack/react-query` inspection passed once with a 61-second Baseline install. The next run of the same upgrade stopped when its Baseline install hit the 180-second install limit on a sandbox running about twice as slow. The report then said "The inspection reached its time limit." That message is wrong: the 30-minute inspection limit had not been reached. Only one step's limit had. `bounded()` raised the inspection `deadline` code for any expired timer, so the inspection stopped instead of recording an untested install.

## What Changes

- Raise the default `install` and `tests` check limits from 180,000 ms to 600,000 ms. The 30-minute inspection limit stays as the backstop.
- When an install, typecheck or tests step reaches its own limit before the inspection's, `bounded()` raises a check timeout that names the step and its limit, not the inspection `deadline` code.
- The check records that step as untested with the `command-timeout` reason and a detail such as "The install step reached its 10-minute limit." A Baseline install timeout therefore ends as an untested Baseline install, and the upgrades are skipped for that reason.
- The inspection deadline, the patch verification window and caller cancellation behave as before.
- The site already retries a report with an untested Baseline install or a stopped inspection. A test now proves a resubmission after either starts a new inspection.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `upgrade-inspection`: a check step that reaches its own limit is untested and named, and the inspection continues.
- `hosted-inspections`: a resubmission after a timed-out report starts a new inspection.

## Impact

- `packages/health-code/src/collectEvents.ts`: default limits, `CheckTimeoutError`, `bounded()` and `InspectionContext.step()`.
- `packages/health-code/src/checks/checkProject.ts`: records a timed-out check step as untested.
- Tests in `packages/health-code/test/checkLimits.test.ts` and `apps/web/src/server/cacheUpgrades.test.ts`.
- `packages/health-code/GUIDE.md` and `src/AGENTS.md`.
