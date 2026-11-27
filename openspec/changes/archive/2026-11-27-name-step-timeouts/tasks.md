# Tasks

Follow AGENTS.md with domain-model, code-style and write-docs. Run `bash scripts/preflight.sh` before handoff.

## 1. Check limits

- [x] 1.1 Raise the default `install` and `tests` limits in `packages/health-code/src/collectEvents.ts` to 600,000 ms and keep the 30-minute inspection limit.
- [x] 1.2 Make `bounded()` take the error it raises on timeout, and make `InspectionContext.step()` raise `CheckTimeoutError` when a check stage's own limit ends before the inspection window. Keep the `deadline` code for the inspection, attempt and patch group windows.
- [x] 1.3 Record a timed-out install, typecheck or tests step as untested with the `command-timeout` reason and a detail that names the step and its limit, in `packages/health-code/src/checks/checkProject.ts`.

## 2. Tests

- [x] 2.1 Add a test in `packages/health-code/test/checkLimits.test.ts` where the Baseline install outlasts a one-second limit. Verify the install is untested with the step named, and the report has no stop reason.
- [x] 2.2 Add a timed-out Baseline install and a stopped inspection to the retry cases in `apps/web/src/server/cacheUpgrades.test.ts`. Verify each resubmission starts a new inspection.
- [x] 2.3 Add a test where an upgrade's tests outlast a one-second limit. Verify the upgrade's tests are untested with the step named, the Baseline and the upgrade's install keep their results, and the report has no stop reason.

- [x] 2.4 Wait for the sandbox to end a timed-out command before the next check starts, and add a test where a Baseline typecheck outlasts its limit and the tests still run.

## 3. Docs

- [x] 3.1 Update `packages/health-code/GUIDE.md` and `src/AGENTS.md` for the check limits and the check timeout. Add check limit, check timeout and inspection limit to the domain-model skill.
