# Implementation tasks

## 1. Public options and fake provider

- [x] 1.1 Add the `callerModelExecution` overload, serializable model request sandbox routes and optional provider capability. Pack and compile representative web, CarlNotes-style local, legacy version 1 and model request sandbox callers under Node and Bun. Include exhaustive local callbacks and a provider without model request sandbox support.
- [x] 1.2 Implement the fake model request sandbox with inert route transitions, usage, costs and scripted failures. Verify invalid combinations fail before allocation, lazy reuse across calls, simultaneous first calls and zero work for an Inspection with no eligible model call. Document the capability and Model Request Sandbox term in the library guides and domain-model skill.

## 2. Runta runtime and recovery

- [x] 2.1 Package the trusted, tool-free helper. Implement one bounded exec per request, exclusive per-route egress and the existing revision-checked credential adapter. Exercise both supported protocols, exact host/path/header binding, route switches, refused redirects and failed readback in provider tests. Document the boundary in the provider and guest guides.
- [x] 2.2 Give the model request sandbox its own resource quote, deterministic owner identity, cleanup and reconciliation. Test partial create, lost replies, binding failure, cancellation, callback failure and one deletion failing while the other succeeds. Check the two unresolved IDs and bounded cleanup time.
- [x] 2.3 Extend the shared reaper matcher and wire it into startup and launch-periodic recovery where available. Persist personal model request sandbox ownership before create for setup and MCP Inspections. Test an interrupted owner, a concurrent live local server, an unrelated deployment, a lookalike name and repeated cleanup. Document recovery and verify behavior with either proposal landing first.

## 3. Model requests, timeline and cost

- [x] 3.1 Route only `releaseSummary` and `featureMatch` through the selected provider or local handle. Reuse the current templates, budgets and validation. Compare equivalent fake replies across modes. Test missing release or usage evidence, forged fences, fresh nonces, invalid citations, and zero local fallback on model request sandbox failures.
- [x] 3.2 Add the verified startup event, pin it in MCP and web timelines and render it in the development log. Replay a saved card in each consumer. Confirm a single model request sandbox event, correct resource IDs, independent cleanup and unchanged version 1 output. Update the consumer guides.
- [x] 3.3 Account for both runtime lifetimes, idle time, per-provider rounding, model receipts and retained reservations in the Inspection total. Exercise overlapping runtimes, lower caller caps, an expired deadline, missing receipts and unknown deletion. Check the Report Card, cost grader and launch telemetry agree without double counting.

## 4. MCP setup and acceptance

- [x] 4.1 Separate setup-time registration from inspection-time credentials. Enable model request sandbox mode in the live MCP path. Test setup with an existing secret, one-time registration, rotation, wrong origin, missing key, probe refusal and cleanup failure. Parse both generated client configs and assert the default credential list contains only `RUNTA_TOKEN`.
- [x] 4.2 Exercise a full Inspection through the packed MCP stdio tools with only an inert sandbox token and the fake provider. Require both caller-side roles, a guest Agent Attempt, saved Report Card, Patch handoff and cleanup. Fail the test if a host model client is constructed or a key appears in output, stderr or storage. Repeat with an obsolete local key and verify it is ignored.
- [x] 4.3 Update the README and MCP guide with one-time registration, stored-key-only verification, token-only startup, custom origin/pricing and removal of the previous environment reference. Check the displayed commands and client config against the packed release.
- [x] 4.4 Run offline preflight and strict OpenSpec validation. Separately run an authorized live provider acceptance check using a real stored credential. Measure cold startup, peak memory, warm exec and the runtime cost bound. Verify one authenticated setup probe, successful summary/match calls, registry isolation in the repository sandbox, redacted evidence and confirmed deletion of both runtimes.

## Verification

The packed MCP completed Inspection `c8fd14a3-984f-4430-86f6-9325932f5b11` of `http-party/http-server` at `0d3b7bb5b6e8a59fd450ae2dca65870009cfcd8b`. Setup verified the stored credential with one paid, one-output-token request. The inspection process received only `RUNTA_TOKEN` as a credential. The repository’s network-lock event preceded the model request sandbox’s verified startup. Both deletions preceded the terminal event. A subsequent account inventory confirmed both runtime names were absent.

| Measurement | Observed value |
| --- | --- |
| Time from release evidence ready to verified model request sandbox startup | 22.584 seconds, including prompt preparation |
| Memory at 512 MiB configured | 99.2 MiB peak observed guest usage across 43 samples of `MemTotal - MemAvailable` |
| Warm inference through the model request sandbox | 4.272 s for the first summary, 4.384 s for Feature Match, 11.246 s for the second summary |
| Runtime upper bounds | $0.0193248 for the repository and $0.0043074 for the model request sandbox, including idle time |
| Model cost calculated from receipts | $0.048064 with no outstanding model reservation |
| Total upper bound | $0.0716962 |

The `eol` summary cited its release and its Report Card contained no verified Feature Match. The `express` summary hit its output-token ceiling. All six Upgrade Verdicts were Untested because installation observation was incomplete. The receipt and lifecycle checks passed independently of those Verdicts.

The isolated change passed `bash scripts/preflight.sh` with 203 tests and strict OpenSpec validation. The shared checkout also passed preflight with the concurrent launch changes and 220 tests. The launch ledger settled the same recorded total to 71,697 microdollars after rounding up. Both startup and the launch change’s periodic reaper use the shared sibling matcher. Packed tests cover token-only and obsolete-key environments, Patch handoff and the original local-model overload.

The pre-ship tarball (SHA-256 `3d2326f31eb370feed891b9b452002e1f439b2b3e00b298e1ffba25a9c377060`) passed stored-key-only setup and repeated the same live Inspection at the same commit after GitHub’s anonymous release quota reset. Inspection `395b3bf0-26d7-42a0-986a-00260743262d` recorded three release-summary receipts and two Feature Match receipts. Model cost was $0.093444 with no outstanding reservation. The total upper bound was $0.1170762. The Report Card recorded both deletions, and Runta’s account inventory subsequently contained neither runtime.

The ship review repeated live setup in a fresh home using only `RUNTA_TOKEN`. The revised build verified the organization, proved gateway denial before attachment, issued the authenticated probe limited to one output token, confirmed deletion and printed the token-only configuration.

The ship build (tarball SHA-256 `185034a7f2c4a426e7a8c8620a553f79ff4fdd3fb093bca724399204ceb11c61`) repeated the packed MCP Inspection at the same commit in a fresh home using only `RUNTA_TOKEN`. Inspection `df8d5043-18ec-4ca2-8f39-b7abeda5d768` recorded three release-summary receipts and two Feature Match receipts. Model cost was $0.087184 with no outstanding reservation. The total upper bound was $0.1108162. A separate inventory check confirmed both runtimes were gone. All six Upgrade Verdicts were Untested because the installation observer was unavailable.

## Workflow follow-up

- After design approval and implementation, complete the ship review, archive the OpenSpec change, then commit and push with authorization.
