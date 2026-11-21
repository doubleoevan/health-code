# Implementation tasks

## 1. Site entry and replay

- [x] 1.1 Add the Hono server and Vite/React browser and server entries in the Bun workspace. Build the site and request its home page and a fingerprinted asset from the production server.
- [x] 1.2 Add a sanitized recorded event/card pair, fixture metadata responses and separate provisional examples for missing agent fields. Test recorded timing with a fake clock and verify production rejects replay configuration.
- [x] 1.3 Document the replay command, build, runtime entry and public package boundary in the site guide and README. Run the documented replay command without credentials.

## 2. Submission and storage

- [x] 2.1 Add the form and single submission function. Route-test accepted HTTPS forms, invalid hosts, userinfo, ports, encoded paths, queries and missing input. Confirm invalid URLs schedule zero work.
- [x] 2.2 Add SQLite migrations, site IDs, event uniqueness and queued worker claims. Test immediate 202 responses, ID collision retry and three submissions against two execution slots.
- [x] 2.3 Check GitHub visibility before sandbox allocation and present project detection reasons. Test private, missing, rate-limited, mixed-language, unsupported and ambiguous fixture cases.
- [x] 2.4 Implement completion, failure and restart recovery. Reopen the database in tests and verify queued work resumes, every previously running row shows the restart message at its existing URL, and completed links still resolve.
- [x] 2.5 Document the volume path, single replica, schema compatibility, backup schedule and restoration steps. Restore a test database and verify a saved URL and Patch digest.

- [x] 2.6 Extend the public Sandbox Provider factory with deployment-scoped naming and cleanup. Use fake inventory tests to cover multiple pages, missing rows, live allocations, adjacent prefixes, and default CLI/MCP names.
- [x] 2.7 Reconcile orphaned runtimes before the worker claims jobs. Simulate a crash before the allocation was recorded, a failed deletion and a second startup. Verify orphan removal, queued work resumption and stable interrupted timelines. Document the deployment prefix and retry behavior in the library and site guides.

## 3. Live Inspection

- [x] 3.1 Store each event before notification. Test SSE replay, native cursor precedence, heartbeat, disconnect cleanup and an event appended during catch-up.
- [x] 3.2 Render the snapshot and hydrate from its cursor. Test reload mid-step, timer progression without output, pinned controls, collapsible details and repeated delivery of a sequence.
- [x] 3.3 Publish terminal site state after finalization. Test the interval between the library's final event and Report Card persistence, a failed Inspection and reconnecting at the last sequence.

## 4. Report Card and Patch publication

- [x] 4.1 Render the summary, Baseline, Upgrade evidence and full timeline. Render every Verdict from fixtures, multiple workspace versions, missing measurements, incomplete observations and an empty selection.
- [x] 4.2 Serve server-rendered metadata and canonical URLs. Test crawler HTML without JavaScript, escaping, count agreement, Copy link and Share fallback.
- [x] 4.3 Resolve license eligibility at the pinned commit. Test permissive, AGPL, GPL and MPL identifiers, a changed default-branch license, non-OSI, missing, unknown and lookup-failure cases across report HTML, hydration, SSE details, downloads and copied prompts.
- [x] 4.4 Store exact Patch bytes by digest and publish associations atomically with the report. Re-hash downloaded bytes after restart. Test unknown digests, hash mismatch, application order and failed publication.
- [x] 4.5 Add the Claude Code and Codex handoff with Runta signup and a stable MCP setup destination. Check every link and verify “Copy patch instructions” includes the library text, immutable URLs and digest checks.
- [x] 4.6 Check the shared components at phone and desktop widths in both themes. Exercise keyboard disclosure, reduced motion and readable Verdict text without color.

## 5. Live integration and handoff

- [x] 5.1 After the agents change exposes its public contract, bind live options and report rendering to exported types. Verify every role uses configured Claude Opus 5.5, secret-name and optional token forwarding, limits, and server-only settings using an offline call capture.
- [x] 5.2 Verify replay examples against the merged contract and confirm the sandbox agent-start label has direct event evidence. Test a stored v1 card alongside a full agent-produced card.
- [x] 5.3 Confirm MCP setup instructions against the released integration. Exercise verified Patch retrieval through the documented tool when available and direct download independently.
- [x] 5.4 Update the root routing guide, site module guides and README with live and replay operation. Build the production container locally and verify it serves the compiled page, static assets and streaming endpoint against its mounted database.
- [x] 5.5 Run credential-free preflight and the project ship review. For demo acceptance, inspect one public licensed Repository using the live configuration and verify its permanent report and any published Patch bytes.

## Workflow follow-up

- After review, follow the repository’s OpenSpec archive and authorized shipping sequence on main.
