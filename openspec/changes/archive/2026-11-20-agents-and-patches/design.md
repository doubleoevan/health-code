# Agents and patches for Health Code

## Context

`inspectRepository` already pins a public Repository, establishes a Baseline, confirms new failures, emits ordered events and owns sandbox cleanup. Version 1 accepted legacy string model settings, removed Git metadata on reset, and retained failed tests and unexpected install findings. version 2 Inspections also need a protected commit history, passing and skipped cases, and the destinations contacted during each phase.

## Goals / Non-Goals

The deliverable is a portable library result a maintainer can act on. The most valuable result is a cited Feature Match with a tested simplification. A maintainer should also learn where a feature fits when adoption falls short. Consumers own model routing, storage, patch delivery and publication. The library makes no pull requests.

## Approved decisions

| Decision | Default | Reason |
| --- | --- | --- |
| In-sandbox agents | One bundled TypeScript guest using the AI SDK's bounded tool loop, with distinct repair and feature adoption prompts and tool permissions | Both roles can use a caller-selected endpoint, including an OpenAI-compatible proxy. A general-purpose CLI adds implicit tools, routing and billing behavior. |
| Models and placement | Four required roles in the new configuration. Two host-side model handles and two serializable guest routes | Host clients can own authentication. Guest routes can name a stored credential and contain no real key. |
| Ceilings | version 2 Inspection up to 60 minutes, $15 and six upgrades. Repair up to 40 turns, 20 minutes and $4 per attempt. Feature adoption up to 25 turns, 10 minutes and $2 per attempt. | Callers can lower each cap independently. Each turn also fits the remaining Inspection budget. The check-only defaults remain 30 minutes and $0.25. |
| Feature Matches | Try the best three across the Inspection, at most one per green Upgrade by default. Allow a caller limit of zero | A global ranking favors concrete opportunities. One adoption series per upgrade gives the maintainer a single feature patch to review. |
| Metering | Per-request model usage, caller-supplied price bounds, and pre-call reservations. WatchFox is optional corroboration | An after-the-fact session estimate cannot enforce a hard ceiling across arbitrary model hosts. |
| Can't fix | Diagnosis only. Publish neither a partial patch nor an apply prompt for that upgrade | A published Patch promises that the returned commits passed the final check. |
| Recognizing tests | Combine the runner's discovered files and stable case identities with conventional filenames, configured roots, fixtures and snapshots | Filenames alone miss custom suites. Reporter output alone misses a deleted or newly excluded suite. |
| Evaluation | Versioned JSON cases under root `evals/`. Score with `bun run eval --case <id>` or `--all`. Record the first CarlNotes Baseline with `bun run eval --case carlnotes-baseline --record`. | A maintainer reviews the measured counts and test file errors in the case file before scoring. |

### Public API and compatibility

Keep the same options object and public function. A missing models field or an existing string dictionary, including `{ future: "unused" }`, follows the current code path, emits version 1 events and returns the current Report Card. The new overload opts in through structured roles. Keep the original published types and overload for consumers that explicitly type options or exhaustively switch on version 1 events. Reject malformed structured configuration before allocation.

Illustrative call shape using caller-owned values:

```ts
const card = await inspectRepository({
  repositoryUrl,
  sandboxProvider,
  githubToken, // Optional, stays in the caller's process.
  models: {
    releaseSummary: { model: summaryModel, pricing: summaryPrices },
    featureMatch: { model: matchingModel, pricing: matchingPrices },
    fix: { ...fixRoute, pricing: fixPrices },
    adoption: { ...adoptionRoute, pricing: adoptionPrices },
  },
  limits: {
    maxCostUsd: 15,
    maxDurationMs: 3_600_000,
    maxFeatureMatches: 3,
    agent: {
      fix: { maxTurns: 40, maxDurationMs: 1_200_000, maxCostUsd: 4 },
      adoption: { maxTurns: 25, maxDurationMs: 600_000, maxCostUsd: 2 },
    },
  },
  onEvent,
})
```

A host role takes a configured model object. A guest route contains `protocol`, `baseUrl`, `modelId`, and `credential: { name, header, valueTemplate }`. Select the trusted transport by wire protocol (initially Anthropic Messages or OpenAI-compatible chat). Require a caller-supplied HTTPS endpoint for either and support proxy base paths. Reject unrecognized protocols, embedded credentials and inconsistent routes. Keep model IDs, hostnames and prices out of library defaults. The site's intended choice is Claude Opus 5.5 for all four roles. CarlNotes can route matching and adoption through its own LiteLLM endpoint to Claude Fable 5.2. These are caller examples, not tested model availability claims. [AI SDK tool loop](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent) · [OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers/custom-providers)

Use an opt-in version 2 report/event envelope with the same repository, selection, Baseline, original Check Results, ordering, ID and terminal guarantees. Each upgrade gains a cited summary, ranked matches and disposition, locators, size delta, Verdict, dependency reviews, patch series and application prompts, optional diagnosis, and usage per step. A green repair retains the initial failed Check Result and its confirmation alongside final evidence. Emit typed step starts/finishes for reading, matching, each role/attempt and final checks, with upgrade and attempt identifiers. Emit a distinct `agent-started` Sandbox Event after isolation is verified. The existing creation-time `credentials-withheld` event retains its meaning. Pin Sandbox Events in the developer log and preserve them in timeline replay. The v2 union is opt-in so stored v1 fixtures, type narrowing and packed Node/Bun consumers keep working.

The version 2 upgrade entry exposes these groups so the site and MCP server can share fixtures:

| Field | Contents |
| --- | --- |
| `releaseSummary`, `featureMatches` | Release claims and sources, pinned usage permalinks, rank, attempted disposition, measured benefit and optional feature patch ID |
| `locators`, `installSize` | Diagnostic kind and pinned location or unavailable reason; Baseline and upgraded bytes, signed delta and method |
| `verdict`, `newDependencies`, `diagnosis` | Final label and evidence, reviewed names/versions/commit reasons, and failing tests, breaking change and attempts where applicable |
| `patches[]` | Role, base and tested tip SHAs, prerequisite patch ID, filename, UTF-8 mailbox text, digest over the exact UTF-8 bytes, flagged commits and consumer agent prompt |
| `modelUsage[]` | Step, role, attempt, caller-selected model ID, token counts, time, calculated cost and any unsettled upper bound |

Use a stable per-inspection patch ID or digest for associations. Deliver bytes only in the returned artifact fields. Live progress carries identifiers and status so consumers can publish evidence separately from their patch delivery decision. Provide a packed v2 fixture for both consumer proposals.

### Credential and process lifetime

Add an optional scoped capability to Sandbox Provider. A binding identifies the sandbox, exact model origin and endpoint path, credential name, header and value template. Its lifetime is one attempt. The live provider resolves the stored name at the gateway. The fake records attachment, readback, policy changes and removal using metadata alone. Existing providers remain usable for version 1. A provider lacking verified binding support cannot start a paid attempt.

During trusted agent inference the supervisor replaces the entire policy with the registry hosts plus that role's one model hostname and verifies readback. Install, build and test execute in separate command phases with registry-only policy and the binding removed. Quiesce repository processes before attaching a binding. Isolate the guest agent from repository executables, configuration, writable dependencies and child processes. Agent tools read or propose scoped repository edits and request predefined checks. A trusted supervisor switches phases, waits for every child to stop, and restores verified isolation on every exit. Repository processes cannot spend the agent's credential. A failed transition stops execution and triggers cleanup. The agent cannot call the control plane, change policies, supply an arbitrary shell command or push Git refs.

Keep the HTTP integration in one private Runta provider function, `setCredentialBinding`, for attachment and removal. Mark it to switch to `runtime.secrets.setSecretStub` once the TypeScript SDK ships it. The existing SDK can continue to provision runtimes. The control-plane token stays in the provider.

We traced `runta secret rule set` in CLI 0.2.19 against a loopback recorder with dummy IDs. It reads secret metadata from `GET /v2/secrets`, reads the owned runtime with `GET /v2/runtimes/{id}`, then sends `PATCH /v2/runtimes/{id}?expected_revision={revision}`. The Python SDK also identifies `secret_configuration` as a complete replacement. Resolve the caller's stored name to its ID and discard previews. On the dedicated runtime, require the expected starting configuration and reject unexpected bindings, file injection or environment injection. A revision conflict requires a fresh read and verification before another write. [Released CLI 0.2.19](https://www.npmjs.com/package/@runta/runta-cli/v/0.2.19) · [Python SDK 0.2.6](https://pypi.org/project/runta-sdk/0.2.6/)

For a header binding, send the secret ID, empty `environment` and `files` arrays, and one `egress_rules` entry. Set `host_pattern` and `path_pattern` to the exact approved route, `action` to `header`, `name` to the header, and `value_template` to the translated template. The provider translates the caller's single literal `${credential}` token to the CLI's `${secret}`, for example `Bearer ${secret}`. Guest requests carry only an inert value. Reject redirects and routes that bypass gateway injection.

Read back the binding and the effective allowlist. Before each attempt, use a trusted guest probe of the scoped route that requires successful gateway authentication and exposes only the result. Account for any billable probe within the same limits. A failed or inconclusive probe prevents the attempt, its startup event and any agent model request. The live contract must demonstrate that the inert request fails without the binding, succeeds with it and loses access after removal. On return to repository commands, remove the binding with a revision-checked replacement and verify removal and registry-only egress. Destroy the sandbox if restoration cannot be verified.

### Reading releases and selecting work

Resolve the package's repository metadata for the target. Read GitHub releases for the interval from each workspace's locked version (exclusive) to the target (inclusive), following bounded pagination and package-specific tags in monorepos. Deduplicate shared releases, retain applicability by workspace, and use the target package's versioned CHANGELOG for gaps. The optional token is confined to the host GitHub API client for public release reads. Track gaps, truncation, rate limits, missing metadata and source URLs. A missing note never becomes a claim that nothing broke.

Build the usage map from the pinned source inside the sandbox using a JS/TS syntax parser, reusing the existing Oxc parsing pattern. Resolve named/default/namespace imports, literal requires, aliases and called exports. Record workspace, file, symbol and line span. Mark dynamic references unresolved. Summarize changes and breaking behavior in the caller's process. A match must cite both the specific release claim and code it would replace. Cover workarounds, removable dependencies, deprecated calls and newly available options. Rank direct cited replacements ahead of inferred matches, then by number of affected verified call sites, dependency, path and line. Select across candidates after check/repair results are known. Unselected matches keep their reason and evidence.

Store role prompts as versioned Markdown with the prompt-authoring frontmatter. Bound each input, strip delimiter-shaped tags and backticks, and wrap each untrusted value with a fresh per-call nonce. Apply this to notes, paths, source, diagnostics, earlier model text and tool results. Interpolate once and keep trusted output instructions last. Validate structured output and links against a trusted evidence index before display or tool use. Treat a summary as untrusted input to matching.

Generate typecheck, test and deprecation locators against the original tested full SHA. Use workspace-relative paths and checked line mappings, percent-encoded GitHub blob links and validated line spans. If an upgrade-only line has no original mapping, preserve the diagnostic and explain the missing permalink. Measure installed dependency bytes with the same manager, platform and clean-install policy on both trees. Sum regular-file logical lengths in installed dependency roots, counting hardlinked inodes once and avoiding symlink traversal. Record before/after bytes, signed difference and method. Unsupported layouts, including unresolved virtual installs, get an unavailable reason.

### Agent budgets and evidence

Use one inspection-wide ledger for the VM, host calls, both agent roles and cleanup. Cap agent output at 8,192 tokens per turn and host calls at 45 seconds and 1,024 output tokens. The first applicable role, caller or Inspection ceiling ends the work. Time, money, cancellation and turn limits apply even while a model request is in flight. Price input, output, cached/reasoning tokens where billed, plus fixed or proxy fees, from a caller-supplied schedule with upper bounds valid for the route. Before dispatch, reserve the worst-case charge for bounded input and capped output plus remaining VM/cleanup obligations. Use integer microdollars, round reservations up and make a reservation atomic. Count each provider request, including retries. Disable opaque automatic retries. Unknown pricing or a missing upper bound prevents dispatch.

The protected agent transport reports request ID, step, model, usage and duration independently of agent-generated text. Reconcile the reserved amount with authoritative response usage and caller pricing. On lost usage, retain the conservative reservation, mark cost as bounded/unknown, and stop subsequent paid work for that attempt. Report measured tokens, calculated cost and unresolved reserved cost separately. Optional WatchFox session telemetry can corroborate a correlated request after completion. The documented findings expose estimated token counts. They cannot establish real-time, provider-independent billed cost. Session payload capture is unnecessary. [WatchFox finding fields](https://runta.com/docs/reference/api/operations/listwatchfoxfindings/)

Repair starts only on a confirmed, attributable regression. Feature adoption starts on a green tree, including an accepted repair. An attempt may propose edits and a reason, but the supervisor owns allowed paths, command selection, test manifests and commits. Adoption compares with its immediate green parent. Accept a decrease in normalized nonblank production source lines, removal of a direct dependency, or removal of a previously identified deprecated call. Exclude generated files, lockfiles, tests, formatting-only and minification changes from the line metric. A green edit with no verified simplification leaves a cited finding without a feature patch.

### Test integrity and final verification

Capture a protected inventory at Baseline from the adapter's discovered test paths and reporter cases, keyed by workspace, path and qualified case name. Preserve passed, failed, skipped/todo and file-load states. Recognize configured discovery patterns, conventional test folders, `*.test.*`, `*.spec.*`, snapshots, and supporting files referenced by the discovered suites. Treat a change to runner commands, filters or discovery configuration as affecting test integrity. Existing passing tests must still exist and pass. Named Baseline failures and unloadable files remain visible and excluded from upgrade blame. They cannot disappear behind a new skip, deletion or narrowed test selection. Incomplete identity evidence precludes an accepted agent Patch. The existing check-only path can still report exit-level results.

A new test is allowed. For an existing test edit, require a reason tied to documented changed library behavior, a retained case identity, a separately flagged commit, and comparable evidence from the original and new assertion against the old/new behavior. Reject removed assertions, new skips, empty bodies, broad snapshots/rewrites, disabled checks or unprovable equivalence. Mechanical checks establish inventory and concrete differential behavior. A maintainer reviews the flagged semantic claim. A fix can introduce a dependency only with a specific replacement rationale, one flagged commit per added direct dependency and observed clean installation; include transitive lock changes in the relevant commit. Surface name, version, reason and commit for review.

Keep a protected Git object store and a disposable worktree in the sandbox, both rooted at the pinned commit. Current reset deliberately removes repository Git metadata. Let the trusted patch builder create commits using a controlled Git configuration, hooks disabled and no remote credentials. The agent edits scoped files. Freeze the allowed set before editing from the trusted usage map, relevant manifests and lockfile, test paths, and attributable failing-check files. Reject path traversal, symlink escapes, unexpected file types and edits to runner/configuration that would suppress evidence.

Order the version bump and lockfile first, each flagged new dependency next, then one logical fix per commit, then any flagged existing-test edit. The validated feature series applies to the exact accepted upgrade tip. Reapply each exported series to a fresh checkout before yielding bytes. Recheck permitted paths and commit contents, compare workspace and installed-package metadata for new or newly enabled lifecycle hooks and reject these or undeclared dependency additions, then run the observed Install Check, applicable typecheck and tests. Collect complete attempted destination hosts during both Baseline and final install/tests, including allowed registry hosts. Compare by phase; unknown coverage or a new destination rejects the patch. A known off-registry install attempt still stops the candidate. Validate intermediate commits for scope and dependency attribution and each final tree for behavior. An unsuccessful adoption preserves the already accepted upgrade series.

Publish UTF-8 `git format-patch` mailboxes with filename, SHA-256 digest, repository base, applies-to and tested tip SHAs, commit subjects, reasons/flags and ordering. Verify `git am` by resulting tree equality; fresh committer metadata can change commit IDs during replay. Return one instruction string for each retained patch: branch, apply prerequisite series then this mailbox with `git am`, minimally adapt if the branch moved, disclose the exact adaptation, typecheck and test without editing tests, fork first when appropriate, then open a PR using the supplied commit messages. Use safely quoted application-owned placeholders for the consumer's delivery location. Nothing publishes during inspection.

### Verdict and evaluation

`Passes as is` means a verified bump-only upgrade. `Fixed` requires green repair commits and unchanged existing tests. `Fixed with test changes` also names the flagged test commit and reason. List every accepted dependency addition on either fixed verdict. Report adoption separately so a rejected feature edit cannot turn a passing upgrade red. `Can't fix` requires a confirmed break and exhausted attempts or no acceptable repair within the ceiling. Include failing identities, supported breaking-change explanation (or uncertainty), actions tried and stop reason. `Untested` records an unusable Baseline, absent tests, incomplete observation, unconfirmed failure, unavailable controls or insufficient evidence. A rejected bump with insufficient installation evidence is Untested. A rejected repair leaves the confirmed break eligible for another bounded attempt, then Can't fix at the ceiling. Report the evidence for “passed inspection.”

Use a discriminated JSON case with schema version, ID, kind, public Repository/full SHA, precise Upgrade or Baseline-only selection, expected stage results and verdicts, disqualifying conditions, and optional reference commit and parent. The evaluation harness pins the exact dependency/target while using the production checking, repair and patch paths. The latest registry candidate is unsuitable for a historical case. Record the effective limits and report normalized source diff against the reference separately from correctness. Never send the expected answer, reference patch or historical fix to the models.

- **TypeScript repair.** `doubleoevan/health-code@7e6d81920e7959933822dc628fe7ad184f56cf61`, TypeScript 5.9.3 → 7.0.2. Expect the new failure to repeat, a locator at `scripts/readWorkspace.ts` for the removed config API and evidence for the parser in `scripts/readImports.ts`. Capture boundary-test diagnostics even if typechecking also fails. Run the budget acceptance check with the public defaults and no case-specific overrides. It passes only on Fixed with passing tests, no edits to existing cases and reviewed new dependencies if needed. Report turns, elapsed time and spend alongside the Verdict. A Can't fix result earns an explicitly labeled acceptable diagnosis only when the evidence identifies the same break and attempts. Passes as is, weakened tests, unflagged dependencies or an unverified patch fail the case. Score reference `f89eebc05313cb8e49e1d81934ac2484f640cb92` against parent `cc0c5319b89410fc71ff9b7359f49fd11916e2c7`. The reference adds get-tsconfig, oxc-parser, oxc-resolver, test cases and a Biome migration. Equivalent fixes can differ; the unrelated schema edit is not an acceptance condition.
- **CarlNotes Baseline.** Pin `doubleoevan/carlnotes@2c229c8d44e957e93d5178a8664d5e2d5cbbe0f6`. The first invocation is `bun run eval --case carlnotes-baseline --record`. Run the production Baseline once at that SHA, with zero upgrades, no model calls and no application keys in the guest. Read the protected test inventory. Measure passed, failed, skipped and todo case counts. List test file errors separately by workspace-relative path and reason. A load failure has no discovered case to count. The reviewed record at this commit contains 5,593 passed, 5 failed, 26 skipped, zero todo and zero test file errors.
- After a complete measurement and cleanup, atomically update the measured expectations in that case file and mark them pending review. Preserve the pin, selection and grading rules. An incomplete inventory or wrong checkout leaves the case file untouched. The maintainer reviews the diff and marks the case reviewed. Scoring with `--case` or `--all` reads the reviewed expectations, reports count or exclusion drift, and never rewrites them. Record mode targets a single Baseline case and issues no passing score.

Score each case with pass/fail, desired versus acceptable outcome, actual Verdict, existing case changes (distinguish added cases inside an existing file), dependency flags, reference source diff, time and cost. Manual invocation or an explicitly dispatched report-only workflow publishes scores. Preflight covers schema, scoring, fake model and fake sandbox tests offline. Exercise successful and rejected adoption in deterministic fixtures; neither of the two requested live seeds measures feature-adoption quality.

## Risks and migration

Start with packed-library v1 compatibility fixtures and adversarial offline evidence, then prove the provider contract, then enable opt-in execution. Verify live cost bounds, complete observation and cleanup before accepting either series. An opaque runner, dynamic import or missing release reduces what the engine may claim; preserve partial evidence. Bound bytes, tokens, wall time, artifacts and file counts and explain truncation. Consumers can roll back by omitting structured models. Existing stored cards continue to replay.
