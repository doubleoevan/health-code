# Public inspection site

## Why

A visitor should be able to test dependency upgrades by pasting a public GitHub URL. A live record of Runta's sandbox controls and a permanent Report Card let others check the evidence and use the tested Patches.

## What Changes

- Add an anonymous home page, a resumable live Inspection page and a shareable, server-rendered Report Card.
- Accept Inspections through one server function. Bound concurrent work, persist events as they arrive and retain completed reports and published Patch bytes indefinitely.
- At startup, mark running Inspections interrupted and delete orphaned runtimes under this site deployment’s reserved name prefix.
- Publish tested Patches for every OSI-approved license GitHub detects at the inspected commit, including copyleft licenses.
- Show each Sandbox Event in context and pin it for review. Show the library’s Verdicts, evidence and tested Patches with instructions for verifying each download.
- Provide credential-free, timed fixture replay for development and tests. Use real Inspections for the public demo.

## Capabilities

### New Capabilities

- `hosted-inspections` covers admission, background execution, event storage, live progress and development replay.
- `public-report-cards` covers durable report publication, evidence presentation, sharing and Patch delivery.

### Modified Capabilities

None.

## Impact

Implementation belongs in `apps/web` with Bun, Hono, Vite and React. The site consumes the public `health-code` package. The Sandbox Provider needs an additive public interface for scoped runtime naming and restart cleanup. The agents change supplies the additional model options, evidence and Patch contract needed for live publication. The MCP workspace owns its setup instructions and tools. The launch change owns spend caps and caching.
