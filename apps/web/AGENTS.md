# Web application

The `@health-code/web` workspace serves the inspection site. Bun runs its Hono entry in `server.ts`. It serves the Vite client, the anonymous submission API, resumable event streams and server-rendered Report Cards. The browser hydrates `Page.tsx`. `Timeline.tsx` renders ordered Inspection Events and pinned Sandbox Events. `ReportView.tsx` renders source locations, replacement evidence, adoption outcomes, recorded model usage and the tested Patch handoff. Older saved cards can omit those details.

`executeInspection.ts` owns submission, startup recovery and the bounded worker. `storeInspections.ts` owns the SQLite schema and transactions. `streamInspection.ts` replays committed events in pages after the caller’s cursor. Timeline entries fetch raw output on disclosure through the license-checked detail route. `publishReport.ts` constructs the public card and verifies every digest before publication. The original library report remains on the server. `verifyRepository.ts` checks GitHub visibility and license detection at the inspected commit.

Use the public `health-code` package for live Inspections. In development, `replayInspection.ts` streams the version 2 Report Card and event intervals from `fixtures/recorded/`. Tests also read the original version 1 recording. Production rejects replay configuration.

From the root, build the library with `bun run --cwd packages/health-code build`. Use `bun run --cwd apps/web dev` for local work. The `replay` alias starts the same credential-free hot-reload server on port 3000. `developSite.ts` serves Vite Fast Refresh and reloads the Hono routes. `startInspections.ts` initializes storage and workers once per process. Browser and stylesheet edits preserve the worker. Run `bun test apps/web` for HTTP, persistence, replay and publication tests. Build the browser assets with `bun run --cwd apps/web build` and serve them with `bun run --cwd apps/web start`.

## Northflank

Use one container, a writable persistent volume at `/data`, and a stable HTTPS origin in `HEALTH_CODE_ORIGIN`. Build from the repository root with `docker build -f apps/web/Dockerfile -t health-code-web .`. The server listens on `PORT` and stores its database at `/data/inspections.sqlite` by default. `HEALTH_CODE_DATABASE` overrides the path. Use separate databases for development replay and deployment.

Supply `RUNTA_TOKEN`, an optional `GITHUB_TOKEN`, and a stable deployment name in `HEALTH_CODE_DEPLOYMENT` through Doppler. Reserve a unique deployment name per volume and environment within the provider account. Use 1–16 lowercase ASCII letters or digits. The server marks running Inspections interrupted on startup. Before claiming queued work it retries cleanup of orphaned runtimes in that deployment namespace with backoff up to one minute. Report reads stay available.

`HEALTH_CODE_CONCURRENCY` defaults to two. Up to 32 further Inspections can wait in the queue. A full queue returns HTTP 429 before allocating an ID. `HEALTH_CODE_MAX_UPGRADES`, `HEALTH_CODE_MAX_DURATION_MS`, and `HEALTH_CODE_MAX_COST_USD` bound library work. Their defaults are six upgrades, 30 minutes and $5 per Inspection. Set `HEALTH_CODE_MODEL` to `claude-opus-5-5` (the default). Provide `ANTHROPIC_API_KEY` for the two host roles and `HEALTH_CODE_STORED_CREDENTIAL` for the name of the same model credential in Runta. Repair and feature adoption receive only its host-bound reference.

Keep completed reports and published blobs indefinitely. Schedule daily volume backups, monitor free capacity and take a backup before schema migration. For a consistent SQLite backup on a running service, use SQLite’s online backup or `VACUUM INTO` and copy the resulting database off the volume. To restore, stop the worker, mount a fresh volume, restore the database to the configured path and start a compatible image under the same origin. Open a saved report and verify a downloaded Patch against its URL digest. The server rejects unknown schema versions.

Follow code-style, jsx-conventions and vercel-react-best-practices. Review browser interactions against web-design-guidelines.
