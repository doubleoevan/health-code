# Tasks

## 1. Public contract and budgets

- [x] 1.1 Add structured role, independent repair/adoption limits, v2 event and Report Card types to the public entry. Pack the library and compile, call and replay both versions on Node and Bun, including the existing string dictionary and provider.
- [x] 1.2 Implement the shared VM/model ledger. Default to 60 minutes and $15 per version 2 Inspection, 40 turns/20 minutes/$4 per repair, and 25 turns/10 minutes/$2 per feature adoption. Use fake clocks and prices to check lower caller caps, the first exhausted limit, reservations, retries, unknown usage, cancellation and cleanup.
- [x] 1.3 Document caller-owned host handles, guest routes, price bounds and both execution modes in the README and library module guide. Check both examples against the packed declarations.

## 2. Sandbox credential capability

- [x] 2.1 Implement one private provider function for the CLI’s revision-checked runtime PATCH. Resolve the stored secret name, verify the expected runtime state, translate the header template, and replace or remove the rule. Mark the function to switch to runtime.secrets.setSecretStub once the TypeScript SDK ships it. Test the request against the CLI wire format and document the endpoint and version in the provider guide.
- [x] 2.2 Add the optional scoped capability, inert fake and phase coordinator. Test attach, readback, revoke, replace, stale revision, cancellation and failed restoration. Assert zero agent starts, startup events and agent model calls when the binding or policy cannot be verified.
- [x] 2.3 Bundle the trusted agent separately from repository processes. Gate each attempt on successful live authentication at the scoped route. In the live provider contract, prove the same inert request fails before attachment, succeeds while attached and loses access after revocation. Verify registry-only egress for repository commands, secret-free evidence and interrupted role-switch cleanup. Keep live checks outside preflight.

## 3. Releases, usage and prompts

- [x] 3.1 Resolve repository metadata and per-workspace version intervals. Test GitHub pagination, monorepo tags, rate limits, package CHANGELOG fallback and partial notes with recorded inputs. Verify a supplied GitHub token stays in the host API client.
- [x] 3.2 Build the pinned usage map, diagnostic permalinks and installed-size comparison inside the appropriate host/guest boundaries. Test aliases, dynamic imports, generated lines, path encoding, workspace links, hardlinks and unsupported layouts. Update the guest and adapter guides.
- [x] 3.3 Create versioned Markdown templates and one-pass builders for both host roles and both agent roles. Test forged delimiters, nested placeholders, bounded tool output, distinct nonces, trusted final instructions and schema/citation validation without model calls.
- [x] 3.4 Summarize and rank verified matches across the Inspection. Exercise each opportunity category, stable tie breaks, zero cap and a global cap shared by four upgrades. Document ranking and dispositions with a replayable example.

## 4. Comparable tests and agent edits

- [x] 4.1 Extend supported reporters with case states, complete file inventories and test file errors. Test configured roots, added cases in existing files, deleted or skipped cases, missing discovery and opaque commands. Keep initial Check Result fixtures compatible.
- [x] 4.2 Implement repair and feature adoption as distinct roles of the bundled guest. Verify a confirmed repair, a successful simplification, a green edit with no benefit, and a rejected adoption on top of an accepted fix. Exercise both supported wire protocols, a proxy base path, bounded tool permissions and accounting.
- [x] 4.3 Enforce allowed test changes and commit-level dependency reviews. Test an independently demonstrated old-behavior assertion, a weakened assertion, hidden test filters, legitimate added coverage, flagged dependencies and undeclared additions. Document review fields and failure reasons in the affected module guides.

## 5. Final checks and patch handoff

- [x] 5.1 Introduce supervisor-owned Git history rooted at the pinned commit, while preserving clean resets and credential isolation. Verify bump, dependency, fix, test and feature commit ordering in a disposable fixture.
- [x] 5.2 Record complete Baseline and final install/test destination sets and replay the final tree with bindings revoked. Reject new hosts, incomplete evidence, lifecycle changes, scope escapes and undeclared dependencies in offline fixtures. Verify the live provider can distinguish allowed destinations in both phases.
- [x] 5.3 Export ordered format-patch series, hash their exact bytes, and replay both with git am in fresh checkouts. Assert tree equality, dependency and test flags, pinned SHAs, feature prerequisites, moved-branch disclosure and fork/PR instructions. Document the mailbox and consumer delivery contract.
- [x] 5.4 Assign all five Verdicts, populate evidence, phase usage and timeline fields, and update the developer log for both event versions. Share a packed v2 example with the site and MCP consumers. Replay fixtures for every Verdict, a declined feature, a cleanup failure and a partially exhausted budget. Check that a diagnosis-only result has no patch or application prompt.

## 6. Real evaluation cases

- [x] 6.1 Add versioned JSON cases, the manual runner, report-only workflow and evals/AGENTS.md. Document read-only --case and --all scoring and single-case --record. Exercise score and record modes offline, including acceptable diagnoses, default budget acceptance, reference diffs, costs, partial inventories and atomic case updates. Keep live evaluations out of preflight.
- [x] 6.2 Seed the TypeScript case with the design’s pinned versions and reference SHAs. Keep expectations and the reference out of agent inputs. Execute under public defaults, verify the confirmed failure and pinned locator, and report whether the repair achieved Fixed with green checks and unchanged existing tests. Report turns, elapsed time, cost and source diff.
- [x] 6.3 Seed the CarlNotes Baseline case at 2c229c8d44e957e93d5178a8664d5e2d5cbbe0f6 with unmeasured expectations. Invoke bun run eval --case carlnotes-baseline --record once with zero upgrades, zero model calls and no application keys. Write exact counts and sorted test file errors into the case file and present its diff for maintainer review. Verify using fixtures that scoring requires review, reports drift and never edits the file.
- [x] 6.4 Run preflight, packed consumers, the credentialed provider suite, and the explicitly selected real evaluations. Review the resulting reports for secret-free evidence, retained cleanup, measured spend and commit/tree provenance.

## Live verification

On 2026-11-20 the TypeScript 5.9.3 to 7.0.2 case reproduced the compiler failure at `scripts/readWorkspace.ts:19` at commit `7e6d81920e7959933822dc628fe7ad184f56cf61`. The verdict was **Fixed** after five repair turns under the public defaults. Final install, typecheck and all 36 tests passed with existing tests unchanged. The six-commit mailbox replayed to the tested tree, with SHA-256 `352c403cdade4fb56fd3869847b69b02acec238609f8698fc5d008e46a4d1b07`. The full inspection took 7 minutes 43 seconds, with $0.635156 in model usage and at most $0.0257664 in sandbox time. Sandbox deletion was confirmed.

The live credential check observed HTTP 401 before attachment, a metered response while attached, and HTTP 401 after revocation. The live provider suite, offline preflight and packed consumers passed. The CarlNotes record at `2c229c8d` contains 5,593 passed, 5 failed, 26 skipped, 0 todo and zero test file errors. The maintainer reviewed and accepted these measurements.

The final shipping evaluation returned **Fixed** after four turns, with $0.382308 in model charges and at most $0.0225456 in sandbox cost. Its final install, typecheck and tests passed. The five-commit mailbox retained existing tests and its SHA-256 is `d8ee2a3b6a205733225df4cc63aab3bcd36c016d6a66e0c277d8adab0e61a42a`. A separate score-only inspection reproduced the reviewed CarlNotes counts and test file errors.

## Workflow follow-up

- After design approval and implementation, complete the repository's ship review, archive the OpenSpec change, then commit and push with authorization.
