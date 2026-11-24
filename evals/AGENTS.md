# Inspection evaluations

Each versioned JSON file pins one public repository and its expected checks. The TypeScript 7 case also pins an exact upgrade and reference commit. The grader checks the measured time, cost, turn count and output tokens against the approved defaults. The grader alone reads the expected answer and compares source changes.

Run `bun run eval --case typescript-7` or `bun run eval --all` from the repository root with the evaluation credentials. The TypeScript case uses the public default limits and the configured `HEALTH_CODE_MODEL` settings with medium effort for guest edits. Its report under `../logs/` contains the verdict, model charges, elapsed time and reference diff. An accepted upgrade’s format-patch mailbox is saved beside the report. The manual GitHub workflow scores one case and publishes its outcome in the job summary. A failed score leaves the report available for review.

Record CarlNotes with `bun run eval --case carlnotes-baseline --record`. The Baseline uses a pinned 8 GiB sandbox with application variables absent. Review the counts and test file errors in the case file, then change `review` to `reviewed` to enable read-only scoring. Each test file error records the file and reason for a load, setup or runner error outside a named test. Failed and skipped cases have their own counts. Preflight exercises the offline tests.

The runner includes the Inspection Report’s model and handoff prompt references in the result for each Inspection. Compare names, versions and SHA-256 digests when reproducing an Inspection.
