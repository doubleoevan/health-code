# Tasks

## 1. Approval and integration baseline

- [x] 1.1 Record the approved caps, challenge, HTTP Basic admin protection, DNS-only hosting, E2E repositories, prompt contract and tokenless npm trusted publishing.
- [x] 1.2 Verify the model-routing change on main and incorporate its host, guest and Model Request Sandbox call paths before modifying shared model calls. Check public compatibility against a packed Node consumer and an existing stored web card.

- [x] 1.3 Pin Bun 1.4.4 in `.bun-version`, the root package manager declaration and the web container. CI reads the version file.

## 2. Library options, prompt records and accounting

- [x] 2.1 Add optional validated commit pinning. Test branch movement, inaccessible commits, cleanup and callers that supply only a URL.
- [x] 2.2 Inventory model-facing instructions, extract the remaining inline probe and downstream Patch handoff into Markdown, preserve existing role names and versions, and validate the typed override map. Test two callers, invalid and unused overrides, per-call nonces, forged delimiters, placeholder handling and output constraints.
- [x] 2.3 Capture effective prompt references at dispatch, including probes, failures and retries. Carry handoff provenance separately. Publish them in report HTML and eval output. Test default, overridden, legacy and no-call reports.
- [x] 2.4 Add opt-in per-call OpenTelemetry using the caller’s tracer. Cover host generation, guest and Model Request Sandbox boundaries, cancellation, exporter failures and concurrent callers. Inspect captured attributes for secret or content leakage and verify the disabled path performs no export.
- [x] 2.5 Expose measured model and sandbox cost, estimated upper bounds and unknown or pending usage. Test missing receipts, timeouts, multiple runtimes and double-settlement.

## 3. Admission, queue and budget

- [x] 3.1 Migrate SQLite with backup and recovery fixtures. Add unique cache/in-flight identities, queue ordering, daily counters and idempotent reservations. Restore a prior database and verify old report and Patch URLs.
- [x] 3.2 Resolve public GitHub identity, head and size before paid work. Test fresh cache hits at both caps, misses after a dependency-library version or commit change, private transitions, rate limits, size boundaries and simultaneous identical submissions.
- [ ] 3.3 Configure trusted Northflank client-IP handling with DNS-only records, visitor cookie and keyed digests. Validate Turnstile for paid admission. Test cookie removal, shared IPs, spoofed headers, invalid challenges, explicit retry and no raw identifiers in durable records or logs.
- [x] 3.4 Assert public option forwarding of $2 per repair, $1 per adoption, $5 per Inspection and two upgrades; verify independent library defaults. Atomically enforce three starts per visitor per UTC day, two active workers, a 100 MiB repo limit and a $10 daily ledger. Verify concurrent last-slot claims, price unavailability, pending reservations at midnight, reconciliation after interruption and quota updates without redeployment. Test limits refreshing within 60 seconds and fail closed on stale state.
- [ ] 3.5 Render FIFO position through SSR, SSE, disconnect and restart. Verify paid work starts as capacity allows. Lower the daily cap in an isolated deployment, verify the homepage’s reset and MCP link and restore the original limit. Cache hits and saved reports remain usable.
- [ ] 3.6 Schedule scoped, age-aware cleanup. Exercise multiple inventory pages, missed creation events, stale leases, adjacent namespaces, retry and an abrupt worker shutdown. Verify removal against provider inventory and the Runta dashboard.

## 4. Operations and first-party signals

- [ ] 4.1 Serve health/readiness and allowlisted structured terminal logs for completion, failure and interruption. Test redaction at app, proxy and provider boundaries.
- [x] 4.2 Track eligible foreign views and ensuing new Inspections idempotently. Check self-views, previews, repeated views, cohort windows, retention and zero denominators.
- [x] 4.3 Protect all admin endpoints with HTTP Basic over HTTPS using Doppler’s `HEALTH_CODE_ADMIN_PASSWORD`. Test missing configuration, absent/wrong credentials, provider-hostname access, password rotation and log redaction. Verify daily signals, spend, holds and cap counts against a known ledger.

## 5. Deployment, packaging and documentation

- [ ] 5.1 Configure one Northflank container from the existing web Dockerfile, persistent volume, Doppler production secrets and a separate limits configuration. Verify backup/restore, DNS-only resolution to Northflank, health probes, HTTPS redirect, Northflank TLS and alternate-host protections before public paid admission.
- [x] 5.2 Build both npm tarballs with individual READMEs and an exact-version scoped MCP launcher. Test the existing unscoped command and the new scoped command via clean Node stdio installs. Inspect contents for missing templates, consumer artifacts or credentials.
- [ ] 5.3 Bind both packages to the GitHub Actions release workflow in npm trusted publishing. Test tag-gated OIDC staging with provenance, stage-only permission, no GitHub environment and no `NPM_TOKEN`, including permission scoping, provenance and recovery after a partial publication. Use a dry run before an authorized tag. The maintainer approves each staged version on npmjs.com. Verify both public package digests and provenance after approval.
- [x] 5.4 Update the root README and affected module guides with the public URL, offline replay, quick starts, Runta network/secret behavior, architecture diagram, real versus mocked flows, tests, license, limits reload and operator recovery.

## 6. Acceptance and handoff

- [x] 6.1 Run credential-free preflight and regression tests. Cover both Untested and Can't fix with pinned evidence and assert their rendered reasons.
- [ ] 6.2 Run the explicit hosted E2E suite on the approved repos. Capture cold-start links, actual SHAs, prompt versions, terminal states, rendered findings and provider-side cleanup. Repeat CarlNotes and confirm the identical report URL and zero incremental spend.
- [ ] 6.3 Verify concurrent queue positions, cap handoff, admin cohorts and crash recovery on an isolated deployment. Reopen a real signed-out HTTPS report in a private browser and on a phone. Record live coverage and any fixture-only verdict coverage separately.
- [ ] 6.4 Complete the project ship review, present deployment and package evidence, and follow the repository’s authorized archive, commit and release sequence.

## Verification in the launch checkout

- The Bun 1.4.4 production image built from the repository Dockerfile. A local container capped at 256 MiB served the homepage and readiness probe, opened SQLite and required authentication for admin while provider networking was unavailable.
- Replay tests covered queue position on initial HTML and after reconnecting to a restarted worker, idempotent cost settlement across midnight, and daily admin numerators, denominators and charges. A local Chrome check used a simulated Turnstile response to exercise failure, explicit retry and automatic continuation for the same repository.
- The production worker’s configuration reader loaded the eight approved ceilings from the separate Doppler limits configuration. The production widget credentials are configured in Doppler. A real Turnstile verdict and the ingress client address still need verification on the canonical hostname.
- The maintainer confirmed staging-only npm trust for both packages and reserved the scoped name at 0.0.1. Both 0.1.0 tarballs passed npm’s offline staging dry run with provenance enabled. Registry signatures and provenance require an actual tagged staging run and maintainer approval.
- Northflank project `health-code` in `nf-us-west` now has a single-replica `web` service on `nf-compute-20` (512 MiB), configured to build `apps/web/Dockerfile` from the repository root. Port 3000 is private. Liveness and readiness target `/health/live` and `/health/ready`. Automatic builds are disabled pending the reviewed launch revision.
- Northflank attached the `inspections` ReadWriteOnce volume at `/data`. The platform requires 6 GiB for NVMe in this project. The volume awaits its first deployment. Northflank rejected the daily backup schedule because scheduled volume backups are disabled for this account.
- The `doppler-runtime` secret group injects the read-only production config token into `web` at runtime. Northflank’s group restrictions and the token transfer were verified. The first hosted build, runtime boot, DNS, TLS, ingress checks and backup restoration are pending.

- Integrated the Model Request Sandbox API from main at `9685f3d`. Packed Node replay covered both model execution options and saved-card regression tests covered missing prompt versions. Local SDK, guest SDK and Model Request Sandbox transport fixtures checked prompt identity, per-call timing and model receipts. Failed dispatches retain their prompt reference. Pre-dispatch denials do not consume one.
