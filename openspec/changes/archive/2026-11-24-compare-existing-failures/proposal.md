# Compare upgrades in projects with existing failures

## Why

An upgrade always ended Untested when the original commit had a type error. A failing project using Node's test runner had no per-test results and its test capture could not be read. The menu also skipped packages with more than 8 MiB of registry metadata.

## What Changes

- Exclude type errors already on the original commit and repair only new ones.
- Read per-test results from scripts that run Node's test runner directly or through tsx.
- Read per-test results when a supported runner follows other commands with `&&`.
- Keep an empty capture readable when the test command writes no report.
- Accept registry metadata up to 16 MiB.
- Add a pinned evaluation for an upgrade in a project with existing failures.

## Capabilities

### Modified Capabilities

- `upgrade-inspection` compares type errors with the Baseline.
- `node-ecosystem` collects results from Node's test runner.
- `tested-patches` accepts existing type errors in the final check.

## Impact

The library's checks, guest tools, packed assets, evaluations and module guides change. The site reuses reports whose Baseline type errors are identified.
