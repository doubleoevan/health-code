# Tasks

## 1. Node executable and client discovery

- [x] 1.1 Package the private MCP workspace’s compiled CLI in the existing health-code npm release. Verify the public ESM entry and the health-code bin in the same tarball.
- [x] 1.2 Register the four tools with the official server SDK and validate tools/list over stdio against their names, titles, descriptions, schemas and hints. Verify stdout contains only protocol frames. Update the workspace guide and root module map.

## 2. Setup and model accounts

- [x] 2.1 Exercise the named-secret setter in the selected SDK distribution and match its version with the library provider’s stub support. Test setup with an injected fake SDK and availability check for missing input, rejected token, denied write, repeated setup and key rotation.
- [x] 2.2 Print the two version-pinned client entries, including environment references for the token, host model key and configured overrides. Parse emitted JSON/TOML in tests and check success, failure, stdout and stderr for synthetic credential sentinels, including raw SDK error messages.
- [x] 2.3 Consume the public role contract supplied by agents-and-patches in apps/mcp. Verify all four roles, per-role prices and bounds, host overrides, default model IDs, GitHub release-note credentials and scoped binding teardown through public exports. With fakes, verify the environment key authenticates summaries and matching, only secret references reach the guest routes, and a missing host key prevents paid starts while permitting offline reads.
- [x] 2.4 Add README setup for both clients, including Runta signup, secret-manager launch, variable reference, rotation, where code executes and which accounts pay. Check printed config against the documented examples.

## 3. Inspection execution and saved evidence

- [x] 3.1 Implement start and read against the public library with isolated process-owned Inspection state. With a gated fake provider, prove start returns the library ID before allocation completes, overlapping calls stay isolated, and typed failures and teardown reach the right reader.
- [x] 3.2 Test bounded cursor reads, pinned Sandbox Events, step labels and progress with present, absent and expired tokens. Replay a recorded timeline and check ordering, terminal evidence, summary-first text and structured results.
- [x] 3.3 Save completed evidence and exact Patch bytes atomically. In temporary homes test restart, v1 cards, malformed IDs, interrupted writes, write failure and readback without credentials or network. Document the folder and the lifetime of unfinished work.

## 4. Patch handoff and application results

- [x] 4.1 Fetch tested artifacts via the public contract and verify reconstructed multi-page bytes and hashes, prerequisite order and library prompt against a recorded feature Patch. Exercise absent Patches, unknown history, equal, ahead, behind, diverged and dirty checkouts, digest mismatch and Patches flagged for test edits.
- [x] 4.2 Record outcomes bound to Inspection and Patch identity. Test clean and adapted results, notes, all test statuses, PR validation, duplicate retries and concurrent clients. Reopen the saved record and verify the original Verdict and distinct user results.
- [x] 4.3 Add a README example that starts an Inspection, polls the report, fetches and verifies the feature series, applies it on a branch, typechecks, tests, opens the PR and records the result. Replay the documented tool sequence and check IDs and field names.

## 5. Integration and release checks

- [x] 5.1 Exercise every tool over the packed Node stdio entry with the fake provider and recorded evidence. Inspect text, structured data, errors, progress, logs and persisted output for synthetic secret sentinels. Keep preflight offline.
- [x] 5.2 Verify both target clients can discover and invoke the tools using generated configuration. Check Inspections and Patch reads share the same ID across process restart for completed work. Run the repository preflight and complete the shipping review.
- [x] 5.3 Pack the single unscoped health-code release, install it in a clean Node consumer and verify the library import, both npx commands and the version pin emitted by setup.

## Workflow follow-up

- Archive the approved implementation after review. Follow the repository's separate authorization steps for commit and push.
