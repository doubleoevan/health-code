# Inspection evaluations

| Case | What it covers |
| --- | --- |
| `removed-apis` | A compiler upgrade that removes APIs the code calls. |
| `linked-dependencies` | An upgraded package that requires newer versions of other packages. |
| `matching-versions` | An upgraded package whose tests fail until another package has the same version. |
| `mocked-import-path` | An upgraded package whose import path changed where a test mocks the old path. |
| `baseline-test-counts` | Counts every test at a fixed commit and compares the totals with reviewed results. |

Each versioned JSON file pins one public repository and its expected checks. Each upgrade case pins an exact upgrade. `removed-apis` also pins a reference commit. The grader checks the measured time, cost, turn count and output tokens against the approved defaults. It also checks the Verdict, test changes and linked dependencies. The grader alone reads the expected answer and compares source changes.

Run `bun run eval --case removed-apis` or `bun run eval --all` from the repository root with the evaluation credentials. Each upgrade case uses the public default limits and the configured `HEALTH_CODE_MODEL` settings with medium effort for guest edits. `linked-dependencies`, `matching-versions` and `mocked-import-path` use an 8 GiB sandbox. Its report under `../logs/` contains the verdict, model charges, elapsed time and reference diff where one is pinned. An accepted upgrade’s format-patch mailbox is saved beside the report. The manual GitHub workflow scores one case and publishes its outcome in the job summary. A failed score leaves the report available for review.

Record the Baseline with `bun run eval --case baseline-test-counts --record`. The Baseline uses a pinned 8 GiB sandbox with application variables absent. Review the counts and test file errors in the case file, then change `review` to `reviewed` to enable read-only scoring. Each test file error records the file and reason for a load, setup or runner error outside a named test. Failed and skipped cases have their own counts. Preflight exercises the offline tests.

The runner includes the Inspection Report’s model and handoff prompt references in the result for each Inspection. Compare names, versions and SHA-256 digests when reproducing an Inspection.
