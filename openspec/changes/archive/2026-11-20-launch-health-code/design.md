# Design

## Context

The implementation lives in `apps/web`. Its single Bun/Hono worker already serves a Vite build, stores Report Cards and ordered events in SQLite, interrupts stale work on startup and reconciles a deployment-scoped Runta prefix. Admission currently enqueues a URL before checking visibility and returns 429 after 32 queued jobs. The library resolves the checkout inside the sandbox. Its default is six upgrades. Model receipts distinguish measured cost from a reservation. The evaluation runner has a sandbox cost upper bound.

Four role templates already ship with frontmatter. The builder strips that metadata before generation. Credential verification also sends a short inline prompt, and the final Patch includes instructions for a downstream coding agent. The public tarball currently includes the local MCP executable. The source workspace for the MCP is private.

## Goals / Non-Goals

Give a signed-out visitor a stable Report Card while bounding real spend. Give reviewers independently verifiable package provenance, Inspection evidence and prompt versions. Keep the approved single-volume deployment, existing public URLs and Node library contract. Billing, accounts for visitors, third-party analytics and a hosted tracing backend are outside this change.

## Decisions

### Approved launch settings

| Decision | Setting | Reason |
| --- | --- | --- |
| Visitor limit | 3 new Inspections per visitor per UTC day | Allows a first try and two comparisons. Cache hits and polling are free. |
| Concurrency | 2 active Inspections across the deployment | Matches the current worker limit. Additional eligible work has a visible place in the queue. |
| Hosted spending ceilings | $2 per repair attempt, $1 per feature adoption attempt, $5 total per Inspection | Pass `limits.agent.repair.maxCostUsd`, `limits.agent.featureAdoption.maxCostUsd` and `limits.maxCostUsd` through the public library API. Library defaults are $4, $2 and $15 respectively. Attempt spending counts toward the Inspection ceiling. |
| Daily budget | $10 across model and sandbox spend per UTC day | Reserve up to $5 per admitted Inspection, including its sandbox exposure. Two fully reserved Inspections exhaust the available budget until settlement. |
| Repository limit | 100 MiB, compared with GitHub’s repository size field in KiB (102,400 KiB inclusive) | Admits the measured CarlNotes repository at 78,621 KiB. Apply separate time and disk limits during checkout and install. |
| Upgrades | 2 per hosted Inspection | Gives useful comparisons within the budget. Library consumers retain their six-upgrade default. |
| Turnstile | Enable invisible Turnstile for new, paid submissions at launch | Quotas alone are weak against rotating visitors. Cache hits, report reads and sharing require no challenge. Provide an accessible error, retry and local MCP link on verification failure. |
| Admin access | HTTP Basic authentication over HTTPS | Use the fixed username `admin` and the password from Doppler’s `HEALTH_CODE_ADMIN_PASSWORD`. Apply one middleware to every admin page and data route. |
| End-to-end repositories | CarlNotes, Changesets, Ky and Vercel’s Next.js Postgres template | Four public TypeScript repositories cover an app, workspaces, a library, and a project without a test script. Revisions below identify the selection evidence. |
| Prompt contract | Existing five frontmatter keys, stable filename as name, integer version, optional typed overrides keyed by prompt name | Works with the current templates and lets a caller load a template from its own service before starting an Inspection. |
| npm layout | Publish both `health-code` and `@health-code/mcp` at matching versions. Make the scoped command delegate to the exact public library release. | Preserves `npx health-code mcp` and supplies the requested standalone install without shipping a second MCP implementation. |

### Admission and budget accounting

1. Validate and normalize the URL. Fetch GitHub repository ID, current public visibility and default-branch head before disclosing a cache hit. Look up a completed card by repository ID, full commit SHA and shipped library version. Resolve redirects through GitHub’s public identity check. A private or unresolvable head cannot return a cached card on submission. Existing permanent reports retain the approved publication policy.
2. On a miss, require public GitHub metadata within the size limit. Pass the resolved SHA to the public library through an optional pinned-revision option. Verify the checked-out SHA before executing repository code. A branch move must never store a card under a different commit. A failed or interrupted run can be retried. An active identical request joins the original inspection and queue position without a second charge.
3. Derive separate HMAC-SHA-256 digests for the canonical ingress IP and a cryptographically random first-party visitor cookie, with distinct key domains and a UTC day component for the IP. Persist only the digests. The browser holds an opaque Secure, HttpOnly, SameSite cookie. Apply the daily allowance independently to both digests to limit cookie deletion and network switching. Shared networks can reach the IP limit together. Retain IP digests only through their UTC quota window. Use the cookie digest alone for first-party attribution, with a documented retention window. Derive the address only from a verified Northflank ingress hop and its documented client-IP forwarding behavior. Ignore client-supplied forwarding headers, including Cloudflare headers. Test spoofed multi-hop headers on the deployed ingress before enabling paid starts. Verify Turnstile server-side for new work, including hostname and action. Verify outside the write lock. [Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
4. In one short SQLite write transaction recheck the cache and in-flight key, visitor buckets, capacity and daily funds. Insert at most one durable FIFO row and one reservation, or roll everything back. Return an ID after admission, before sandbox allocation. Show one-based queue position on initial HTML, reload and stream updates. Queued work advances as slots free. Replace the current queue-length refusal for eligible visitors. Terminal report reads and cache hits remain available at every cap.
5. Reserve the combined worst-case model and sandbox cost once within the $5 Inspection ceiling before starting paid work. Subtract sandbox exposure from the amount available for models. Account in integer currency units. Include every runtime attributable to the Inspection, including any Model Request Sandbox. Reject new paid work if rates or upper bounds cannot be established. Use the report’s per-call receipts and provider usage to settle once. Show actuals, estimates and pending reservations separately. On interruption retain a conservative charge until reconciliation. Never treat missing receipts as zero. Attribute reservations to a defined UTC budget day, and carry outstanding liability across midnight before admitting fresh work. Recheck lowered limits before dispatch, preserve already-running work, and explain any wait. At the daily cap the home page shows the reset time and local MCP setup. Storage, rate or identity failures keep paid admission closed.
6. Treat deployment environment variables as the configuration contract. A process cannot observe edits to its parent environment. For **changes without a restart**, use a dedicated non-secret Doppler limits config with the same environment-variable names, a scoped read credential and periodic refresh (target 60 seconds). Env supplies boot defaults. Validate and swap the full config atomically, show its effective time in admin, and retain the last valid snapshot on transient failure. Stop new paid work if a required limit snapshot becomes stale. Changing concurrency or caps requires neither rebuilding nor redeploying the container.

### Runtime, TLS and evidence

Pin workspace Bun, CI and the web container to 1.4.4. Build the existing Dockerfile from the repo root. Mount one durable volume at `/data`, sync production app secrets with Doppler, give the deployment a unique Runta prefix, and publish a DNS-only (unproxied) Cloudflare record pointing to the Northflank custom-domain target. Northflank terminates HTTPS for the canonical hostname. Verify the Northflank certificate, HTTP redirect, client IP trust and alternate-host protections before enabling paid admission. Expose a low-cost health endpoint with liveness/readiness suitable for Northflank probes. Reads can stay healthy during orphan recovery while paid admissions wait. Log structured records keyed by site Inspection ID with canonical repo, duration, state, verdict counts and model/sandbox cost basis. Allowlist fields. Keep keys, raw visitor IDs, cookies, IPs, prompt text and command output out of application, proxy and platform request logs.

Keep the startup sweep. Run an idempotent sweep every five minutes, after listing all pages, scoped to the deployment’s exact prefix and valid IDs. Compare provider creation times with the maximum Inspection duration plus its cleanup allowance. Track live worker leases independently of a stale database status. At the deadline cancel an overdue worker and reconcile its orphaned runtimes. Preserve young, unrelated and valid live allocations. Retry individual deletions and report unresolved IDs to the operator. Test the scheduled path as well as a process crash and replacement on the same volume.

### Daily signals

Count a shared report once when a distinct visitor other than its creator opens the completed card. For share rate, group by UTC completion day and divide shared cards by eligible completed cards in that cohort. For viewer-to-runner, group unique foreign viewers by UTC day of their first eligible view and count those who start an accepted, uncached Inspection within seven days. Label that window and immature cohorts. Record a qualifying hydrated view once per eligible viewer/card, exclude preview bots, operator checks, the creator and repeat visits, and record conversion once. Cookie resets and cross-device visits make these estimates. Retain pseudonymous attribution for 30 days, preserve daily aggregates and show numerator, denominator and an empty-denominator state. Also show daily accepted starts, cache hits, cap hits by reason, model and sandbox costs, and pending holds. Require HTTPS for HTTP Basic authentication on all admin endpoints, including provider-hostname access. Use a timing-safe password comparison and return 401 with a Basic challenge for absent or incorrect credentials. If the Doppler password is unset or empty, disable admin access. Send private, no-store responses and redact Authorization from all logs. Test rotation with old and new credentials.

### Prompts, compatibility and telemetry

Use `title`, `version` (positive integer), `model tier`, `description` and `updated` (ISO date). Use the file stem as stable identity. Retain the four role names, extract the duplicated credential probe and the library-authored Patch handoff into separate templates. Version shared task instructions in the same inventory if they affect a generated prompt. A Patch handoff is recorded as rendered for the user’s agent, separately from prompts sent to models. Keep the credential probe’s fixed security contract. Inventory both host and guest call sites, including calls through the Model Request Sandbox.

Proposed TypeScript surface on the options object:

```ts
type PromptName = ModelRole | "verifyCredential" | "applyPatch"
type PromptOverrides = Partial<Record<PromptName, string>>
prompts?: PromptOverrides
telemetry?: Tracer
```

Each override is the entire versioned Markdown source, supplied by a trusted caller. Load and validate once per Inspection, ahead of sandbox or model spending. Reject unknown names, invalid frontmatter, unsafe placeholders, an override that weakens the credential probe, or an incompatible prompt schema. Keep per-call nonces, evidence bounds, redaction, trusted suffixes, tool permissions and output validation in code. Record name, version and content SHA-256 for effective templates actually used, including overrides, probes and failed model calls. Deduplicate by identity and digest. Record model usage separately from generated handoffs; no-call runs have an empty usage list. Preserve old saved cards with a distinct “Prompt versions unavailable” state. Render the same provenance in eval output and report HTML. Hosted overrides may only change with a new library release so the specified cache key remains valid.

Use caller-owned OpenTelemetry types and the AI SDK’s per-call integration, disabled by default. Configure content capture off; allowlist role, prompt identity/version, token counts, timing and status. Never install a global provider or exporter. A JavaScript tracer cannot cross a sandbox boundary. Instrument the remote SDK call with an in-memory guest adapter that returns bounded, allowlisted timing and correlation metadata to the caller-side tracer; exclude exporters, credentials, raw I/O and telemetry egress from the sandbox. Cover the credential probe and Model Request Sandbox. Two concurrent consumers must have isolated tracers and overrides. Instrumentation failure cannot change the Verdict. [AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)

### Release and reviewer acceptance

Publish both public npm packages from a reviewed version tag on GitHub-hosted Actions runners. Build and smoke-test the exact tarballs with both READMEs before publishing, check tag/manifest parity and exact dependency versions. Bind each package’s trusted publisher to `doubleoevan/health-code` and `release.yml` with staging permission. Use a supported npm CLI on a GitHub-hosted runner with `contents: read` and `id-token: write` for the staging job. Leave the GitHub environment unset. Run `npm stage publish --provenance` for the library and scoped CLI. The maintainer approves each version on npmjs.com. Do not configure `NPM_TOKEN`, a stored registry credential or a token fallback. If either package cannot establish trust, stop before publishing. Verify registry integrity and provenance for both. A retry verifies any already-published matching artifact before publishing its missing sibling. A mismatch stops the release. Test clean Node installs for the library, existing MCP command and new scoped command. [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

The hosted script records the actual admitted SHA and report URL. GitHub selection evidence at proposal time:

| Repository | Revision checked | Purpose |
| --- | --- | --- |
| [doubleoevan/carlnotes](https://github.com/doubleoevan/carlnotes/tree/0d3e3b19c8e3e894ad76c2c664db729f2d4bfe96) | `0d3e3b1` | Product app, Bun workspaces and baseline tests |
| [changesets/changesets](https://github.com/changesets/changesets/tree/704f329e541deebb6a39674ac6ef83c997bf5552) | `704f329` | Workspace monorepo with 21 package manifests and Vitest |
| [sindresorhus/ky](https://github.com/sindresorhus/ky/tree/3541888878c4d303a8bc2ad61815f4e048f55a5d) | `3541888` | Standalone TypeScript library with a test script |
| [Vercel Next.js Postgres template](https://github.com/vercel/nextjs-postgres-nextauth-tailwindcss-template/tree/fe026711c19ac3ee4589c86a738f59b84e611559) | `fe02671` | Next.js app with no root test script or conventional test files at this revision |

Use ordinary hosted admission. Budget the four cold starts across quota windows or explicitly configure a separate deployed acceptance environment with the same code. Run a production smoke on the canonical host. Follow each stream to completion, reopen HTML without JS, check prompt versions and inspect the provider inventory for deletion of all associated runtime IDs. Repeat a URL to verify cache identity and absence of new cost. Live verdicts vary with upstream releases. Use known, genuine stored evidence or offline replay to exercise both Untested and Can't fix deterministically; distinguish that result from a live verdict. Report missing live coverage explicitly. The root README includes the hosted URL, both quick starts, offline replay, tests, architecture diagram, license, and which Runta and product behaviors are real or mocked.

## Risks / Trade-offs

- Anonymous quotas trade friction for fairness. Shared IPs can be limited; the personally funded MCP gives those users a way forward. Launch metrics represent browser identities.
- Budget guarantees depend on an enforceable provider price/time ceiling and successful cleanup. Alert on failed or overdue deletion and disable new paid starts if outstanding exposure is unknown. Infrastructure fees outside the Inspection budget are tracked separately.
- Preserve SQLite backups and legacy report readers through migration. Rehearse restoration, queue recovery and rollback with a saved report and verified Patch.
- The model-routing change and launch both touch call sites. Reconcile with its merged public API and prove the clean-machine MCP flow before tagging. Deployment, paid E2E and publication are release verification steps.
