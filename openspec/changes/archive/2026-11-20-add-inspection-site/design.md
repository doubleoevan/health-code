# Public inspection site design

## Approved decisions

| Decision | Recommendation | Reason and trade-off |
| --- | --- | --- |
| Storage on Northflank | Use SQLite through `bun:sqlite` on a single-writer persistent volume mounted at `/data`. Keep Inspections, events, Report Cards and Patch bytes together. | One container already owns the bounded worker. SQLite gives it transactional publication and offline tests against the production schema. A redeploy briefly interrupts service. Managed Postgres is the better fit when the site needs multiple replicas or independent workers. [Northflank storage](https://northflank.com/docs/v1/application/production-workloads/persistent-storage-in-production) |
| Report URL and ID | Use `/r/<id>` from acceptance through completion. Generate 12 cryptographically random bytes and encode as 16 unpadded base64url characters. Retry a unique-key collision. | One link works while watching, after reload and when shared. A site-owned ID is available before the library emits its first event. Store the library’s Inspection ID separately. |
| Link previews | Send text-only Open Graph and Twitter summary metadata. | The measured outcome fits in the title and description. A generated image adds rendering, storage and another URL for the crawler. Clients control preview appearance. |
| Repositories without a recognized open source license | Publish findings only. Offer Patch downloads and “Copy patch instructions” only when GitHub detects any OSI-approved license at the report’s commit, including AGPL, GPL and MPL. | This sets a conservative publication policy for permanent, anonymous downloads. Public visibility alone is insufficient for this policy. Preserve license notices in eligible Patch bytes. [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) |
| Routing and fetching | Hono owns the home and report routes, API, event stream and Vite assets. Use React server rendering and hydrate the interactive controls. | Two document routes cover three page states. Native navigation, one form submission and one EventSource cover the journey without a client router or query cache. |

## Context

The public `health-code` entry exports `inspectRepository` and the Sandbox Provider factory. Version 1 reports supply the pinned commit, ordered events, Baseline, observations and Check Results. The version 2 contract adds model roles, Verdicts, Feature Matches, release summaries, size measurements, diagnostic links and tested Patches. A Sandbox Event records when an agent starts with its real key withheld.

The site reads both report versions. Its development fixture replays a captured version 2 inspection. The local MCP executable provides verified Patch retrieval from inspections on the developer’s machine.

## Goals / Non-Goals

The site owns admission, durable delivery and presentation. Import inspection behavior only from the public package by name. Keep Bun, HTTP, storage and browser code inside the site. Keep dependency analysis, verdict assignment and prompt authorship in the library. Launch-wide spend caps and result caching belong at the single submission entry point in the launch change.

## Execution and persistence

1. The home form posts a Repository URL to `POST /api/inspections`. Validate the original string against the public library’s accepted HTTPS GitHub root form before normalization. Reject embedded credentials, ports, host aliases, extra path segments, query strings and fragments. Allow the library’s optional trailing slash and `.git` suffix.
2. One server function validates input, creates a queued row and returns HTTP 202 with the public ID and Location. The browser navigates there immediately. The worker verifies public visibility through GitHub's public metadata endpoint before allocating a sandbox. A missing or private repo gets “GitHub couldn’t find a public repository at this URL.” A rate limit or outage gets a retryable verification error. Build requests from validated owner and name against a fixed GitHub API origin. Never follow an arbitrary redirect or authorize access to a private Repository.
3. A single process claims the oldest queued rows transactionally, up to two active Inspections by default. Production reads the role model identifier for Claude Opus 5.5, Runta secret **name**, provider token, optional GitHub token and duration, cost and Upgrade limits from server-only environment settings supplied by Doppler. Validate required settings at startup. Map every exported model role explicitly. Verify the provider-supported identifier during live integration. Pass settings through the public factories and options. Keep values out of browser bundles, events, prompts and diagnostics.
4. Use the library’s pinned-project detection, including workspace and lockfile support. Surface its unsupported or ambiguous project reason on the page. GitHub’s primary language label cannot establish eligibility for a mixed-language Repository.
5. Store the site ID, canonical URL, library Inspection ID, state, timestamps and terminal reason in an Inspections table. Store versioned event JSON under a unique (site ID, library sequence) key. The awaited event callback commits each append before waking readers. A site failure is a site state with an explanation. Only library evidence can establish a Sandbox Event.
6. Snapshot completed public report JSON, attach authorized Patch digests and mark the row complete in one transaction. The library emits its final event before its promise returns. Keep the live page open through this interval. Deliver a separate site completion signal only after the report transaction commits. Failure, including publication failure, also wakes readers. Reconcile a library error’s available timeline by sequence when event delivery failed.
7. On startup, before claiming queued work, the single worker marks every running row interrupted in one transaction. Keep its public link and timeline. Display “This inspection was interrupted when the server restarted. You can start a new inspection.” Only a new submission retries the interrupted work.

### Startup runtime cleanup

Give each site deployment a stable, reserved runtime name prefix that survives container replacement and differs between production, development and other deployments sharing the account. Configure it through the public Sandbox Provider factory. Include a fixed delimiter and the library Inspection ID in each runtime name. Persist the ID from the first event before allocation.

The library exposes `reconcileSandboxes` to clean up runtimes in the configured deployment namespace. The provider handles the runtime API. Standalone callers retain the default `health-code-<uuid>` naming.

Before starting workers, enumerate all pages of runtimes and match the exact deployment prefix and valid Inspection suffix. Delete each matching runtime without a live Inspection, including allocations missing from local storage. Preserve live allocations and all other namespaces. Treat an already absent runtime as cleaned up. On a listing or deletion failure, record the failure and retry with backoff before claiming new work. Keep report reads available during recovery.

## Stream and page behavior

| Route | Reader and response |
| --- | --- |
| `GET /` | One labeled URL field and one button. Explain that AI agents try upgrades inside Runta, the network is restricted to approved destinations, real keys stay outside, and successful attempts can return tested Patches. |
| `GET /r/<id>` | Read status and timeline in one database snapshot. Render a queued, active, failed or completed document. An unknown ID returns 404. Completed HTML contains the report and metadata before hydration. |
| `GET /api/inspections/<id>/events` | Same-origin SSE. Bootstrap from the snapshot’s `?after=<sequence>`. Honor native `Last-Event-ID` on reconnect in preference to that original cursor. A fresh client can start at zero. |
| `GET /patches/<sha256>.patch` | Look up only published bytes by full lowercase SHA-256. Return an immutable cacheable attachment, or 404 for unknown or malformed digests. |

Stream persisted rows strictly after the cursor, in order, with library sequence as SSE ID. Subscribe to notifications before draining and always requery by cursor on wake or heartbeat. This closes the replay-to-live gap. Send heartbeat comments and disable response buffering. After draining, send the durable terminal site state even when the cursor already covers the final library event. Close EventSource and reload the same canonical document on completion. A disconnected reader releases only its subscription.

Reuse the timeline on both pages. Keep one current step, a spinner and elapsed time calculated from its recorded timestamp. Append each finished summary once. Show buffered output, stream identity and truncation behind Show details. Pin labeled sandbox actions and preserve their positions in the chronology. Say “Agent started with its key kept outside” only when the agent contract confirms that event. Use accessible text labels, keyboard controls, reduced-motion behavior and a single-column phone layout in both themes.

The Report Card begins with measured counts, Copy link and a Share button using native sharing with a copy fallback. Count confirmed blocked Install Check findings once, independent of their timeline entries. Count distinct feature Patches from report evidence and label published availability separately. Render all five library Verdicts, including the test changes in “Fixed with test changes.” Display per-workspace source versions. Preserve evidence units, incomplete observations and unmeasured size differences. Present code citations at pinned revisions and keep untrusted text escaped in HTML, hydration data and metadata.

## Patch publication and handoff

Request GitHub’s license detection at the exact commit in the returned Report Card. Compare its SPDX identifier against the full OSI-approved set, including recognized SPDX aliases for the same license. Apply the same rule to permissive and copyleft licenses. A later default-branch license change cannot affect the stored publication decision. Unknown, unrecognized, custom, absent or unavailable license evidence yields findings only. Keep Patch payloads separate from public evidence throughout ingestion. Stream only publishable event fields and ensure raw details, embedded page data and copied text cannot disclose withheld Patch content. If a detail may include a diff or application prompt, withhold its text until publication eligibility is known. Preserve its position and display a reason. Keep private server storage outside the static asset directory.

Hash the exact library-supplied format-patch bytes once. Store immutable blobs keyed by digest and report associations in the publication transaction. Check bytes against any library-supplied digest and reject inconsistencies. “Copy patch instructions” preserves the library prompt and supplies each absolute URL, full digest, base commit and Patch order. Instruct the agent to compute SHA-256 on the received bytes, stop on mismatch and apply the Upgrade Patch before the feature Patch. Apply the same verification when fetching via a released MCP tool.

The local MCP server stores Inspections on the developer’s machine. Offer MCP retrieval only when the tool can resolve this exact hosted Patch by digest. Otherwise use its permanent HTTPS URL. Link the report to the MCP workspace’s documented Claude Code and Codex setup and to [the Runta dashboard](https://dashboard.runta.com/). Omit account and pricing controls in this design. Label any such future demo affordance “Mocked.”

## Risks / Trade-offs

- **Contract drift.** Keep the version 1 compatibility fixture and replay the recorded version 2 inspection with its original event intervals. Check the recording against the public contract. Production uses the live library.
- **Permanent links depend on storage operations.** Retain published rows and blobs without expiry. Keep a stable public origin in server configuration, monitor free space, schedule consistent backups and restore into a fresh volume to verify existing IDs and digest URLs. [Northflank volume backups](https://northflank.com/docs/v1/application/databases-and-persistence/backup-and-clone-volumes)
- **Old reports outlive frontend releases.** Store the schema version and keep a reader for each published version. A v1 Check Result is evidence about a check. Show agent-specific evidence as unavailable when absent.

## Migration Plan

Build and test against temporary SQLite files in replay. Exercise the agents integration against its released public types, then verify the real demo configuration and MCP destinations before launch. For Northflank, mount the volume, initialize a versioned schema and serve the Vite build from Hono. Back up before migrations. Roll back the container to a version compatible with the retained schema, keeping the same volume and origin.
