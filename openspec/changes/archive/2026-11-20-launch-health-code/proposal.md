## Why

A stranger should be able to inspect a dependency upgrade and share the evidence. Today the web app can run real inspections, but each submission can spend money, repeat previous work and leave an operator unable to explain the cost. Reviewers also need a reproducible public release and a way to check which prompts produced a result.

## What Changes

- Serve the existing web container at `https://runhealthcode.dev` using Cloudflare DNS-only records, Northflank TLS, a durable SQLite volume, Doppler configuration, a health check and structured completion logs.
- Extend the single submission path with pinned-commit caching, public repository size checks, anonymous visitor limits, visible FIFO queue positions and a daily budget shared by all workers. Offer the local MCP when funds are exhausted.
- Reconcile stale deployment-owned runtimes periodically. Show daily spend, usage and the two conversion signals on an HTTPS admin page protected by HTTP Basic authentication with a Doppler password.
- Inventory every library-authored model prompt. Use versioned Markdown, expose typed overrides and optional tracing, and show the effective prompt versions in reports and evaluations.
- Publish the library and a scoped MCP entry via npm trusted publishing from GitHub Actions with provenance while preserving the existing CLI. Document both entry points, the architecture and real versus mocked behavior. Exercise the deployed service against four public repositories.

## Capabilities

### New Capabilities

- `launch-operations` — hosting, operating limits, deployment telemetry, private signals and live acceptance.
- `package-releases` — tag-driven, verifiable npm releases and reviewer setup.

### Modified Capabilities

- `hosted-inspections` — cached and coalesced admission, bounded spend, queue position and scheduled recovery.
- `inspection-contract` — pinned execution, effective prompt provenance, overrides, telemetry and cost evidence.
- `public-report-cards` — human-readable prompt versions, legacy report compatibility and the hosted budget handoff.
- `inspection-evaluations` — record prompt versions in evaluation output.

## Impact

Work spans `apps/web`, the public library, the MCP packaging boundary, evaluation and release scripts, GitHub Actions and the root README. The deployment uses Northflank, Cloudflare, Doppler and the npm registry. Existing report URLs, stored cards, library consumers and `npx health-code mcp` remain supported. The approved hosted limits are $2 per repair attempt, $1 per feature adoption attempt, $5 per Inspection and $10 per UTC day. Development, CI and the web container use Bun 1.4.4.
