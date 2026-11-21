# Local MCP server design

## Context

The private `apps/mcp` workspace consumes the inspection, event, provider and Report Card interfaces from the public `health-code` entry. The first start event carries the generated Inspection ID before the provider checks availability. Version 2 Report Cards supply tested Patches, digests, Verdicts and the handoff prompt.

## Goals / Non-Goals

The developer sets up credentials once, launches the server from either client and retains the evidence after closing it. The local agent owns edits, verification and pull request creation in its checkout. The MCP process owns discovery, execution and recordkeeping. The site owns public evidence.

## Decisions

### 1. Ship the MCP command in the existing health-code package

Use `npx health-code mcp` for stdio and `npx health-code mcp setup` for account setup. The release manifest exposes a single Node executable named `health-code`. The prepack step builds the library and compiles the private app into `dist/mcp/` in the same tarball. The executable reads the installed release version for MCP discovery and client configuration.

The app owns the CLI, tools and setup. It imports inspection behavior from the public library entry. The release package declares the pinned MCP SDK runtime dependency. Test both commands from the packed artifact alongside the existing library import. [Official TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

### 2. Expose four tools

| Tool and display title | Inputs | First line and details | Read-only / open-world |
| --- | --- | --- | --- |
| `start_inspection` · Start an inspection | `repositoryUrl` | Accepted, ID, next read and suggested poll delay. Description discloses account usage. | false / true |
| `read_inspection` · Read inspection progress and report card | `inspectionId`, optional `afterSequence`, `waitMs`, `reportOffset` | Status and current step first, followed by ordered events, pinned Runta moments and terminal evidence or failure. Pass `nextSequence` as `afterSequence` for more events. Pass `report.nextOffset` as `reportOffset` for more Report Card text. | true / false |
| `get_tested_patch` · Get a tested patch by SHA-256 | `inspectionId`, `sha256`, optional `checkout`, `offset` | Verdict and checkout first, followed by exact Patch text, base, digest, prerequisites and library prompt. Pass `nextOffset` as `offset` for more Patch text. | true / false |
| `report_patch_result` · Record a patch result | `inspectionId`, Patch selector and digest, application, adaptation notes, test status and optional PR URL | Recorded outcome and Patch identity. Store the user's statement locally. | false / false |

Both text offsets default to zero. Use each returned offset verbatim until it is null. Concatenate the text pages without separators and verify the complete Patch against its SHA-256 digest before use.

Use explicit input and output schemas, structured fields for machines and plain text for terminal readers. Return actionable tool errors for valid requests the app cannot fulfill. Render terminal control characters inert in human-facing previews. Preserve original Patch bytes separately. Use SDK annotations supported by the negotiated revision. Set destructive and idempotent hints to match actual operations (starting two Inspections can incur two charges). Only start performs network I/O. Recording a PR URL never dereferences it.

### 3. Start and poll on both clients

The November 20, 2026 documentation identifies MCP 2026-07-28 and the stable v2 TypeScript SDK. Claude Code accepts server-backed Tasks when a particular request advertises the extension. Codex documents ordinary stdio tools. Its Tasks feature request remains open. A task-only response cannot serve as the common interface. Shipping a second lifecycle just for Claude adds separate recovery and cancellation contracts. Use one ordinary tool-result contract for this release. Reconsider native Tasks when both clients document and pass the same exchange. [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28) · [Tasks extension](https://tasks.extensions.modelcontextprotocol.io/specification/2026-07-28/tasks) · [Claude Code server author guide](https://code.claude.com/docs/en/mcp#mcp-tasks-for-server-authors) · [OpenAI Docs](https://developers.openai.com/codex/mcp) · [Codex Tasks support request](https://github.com/openai/codex/issues/48617)

Launch `inspectRepository` once. Resolve the start call from its first `inspection.started` event, or return its validation error if it rejects first. Own the promise, its rejection handler and abort controller outside the request. Never await sandbox creation to return the ID. Mirror events by library sequence and step identifier. Use the library promise and cleanup result to settle terminal state. For paid duplicate starts, display the ID immediately and instruct clients to reuse the ID on subsequent reads.

Poll immediately by default. Allow a bounded wait of up to five seconds for events after a cursor. Send current-step notifications on a supplied token before returning start or read, and on step changes during an outstanding read. Use increasing request-local progress numbers. End that subscription at response, cancellation or disconnect. Later tool calls can always read the same events. The caller can close the agent after saving the card. Closing the stdio process during work aborts live Inspections and allows bounded library cleanup. A hard kill can lose active work.

### 4. Keep site sharing out of the local release

A developer controls their disk, including Patch bytes, reported tests and any hash stored beside them. An uploaded JSON file or a signature from a self-created local key cannot establish who ran the checks. Do not create an upload endpoint or mint a public report URL. A developer who wants a trusted link can request a separate hosted Inspection. The site's evidence refers to the commit it actually inspects. Future upload support would require an independently trusted issuer signing the Repository, pinned commit, Report Card and artifact digests, plus site verification and the site's publication and license rules.

### 5. Save completed evidence under ~/.health-code/inspections/

Use the home directory returned by Node across platforms. Key each directory by validated library Inspection UUID. Write the immutable versioned card and any separate library Patch bytes into a private temporary sibling, then atomically rename the directory. Apply owner-only permissions where supported. Accept a terminal success only after the write succeeds. The background writer retries transient failures against the in-memory card. After retries are exhausted, reads expose the card with a save error and explain its process lifetime. Store app outcomes separately. Name immutable result records by digest of normalized payload and Patch identity. Atomic exclusive publication deduplicates retries and preserves concurrent distinct reports from two clients. Read through to disk by ID, including after restart. Validate version, shape, size and path containment. A v1 card can return evidence without Patch fields. The library's storage policy stays caller-owned.

### Setup and model routing

Use `createSandboxProvider({ token }).checkAvailability()` for the non-allocating account check. In the setup-only adapter, call the official SDK's tenant secret setter. Reuse a deterministic secret name scoped to the canonical HTTPS model origin. Rerunning setup replaces that origin's Health Code secret and enables rotation. On error emit a fixed diagnostic for the failed operation and discard raw SDK bodies, arguments and stack traces. On success print the config and exit. Repair and feature adoption receive the secret reference. The local MCP process reads the same model key from its environment for release summaries and Feature Matches. The user pays Runta for sandbox time and the model provider for model use. The coding client's own activity uses its existing account. [Runta secret storage and injection](https://runta.com/docs/runtime/secrets-and-secret-injection/)

| Variable | Consumer and default |
| --- | --- |
| `RUNTA_TOKEN` | Setup and live Inspections. Required for either. |
| `ANTHROPIC_API_KEY` | Required for setup and for live summaries and matching in the MCP process. Load it from the same secret manager for both commands. |
| `HEALTH_CODE_MODEL_HOST` | Setup and live routing. Defaults to `https://api.anthropic.com`. Overrides must support the Anthropic request and authentication format. |
| `HEALTH_CODE_SUMMARY_MODEL`, `HEALTH_CODE_MATCH_MODEL`, `HEALTH_CODE_REPAIR_MODEL`, `HEALTH_CODE_ADOPTION_MODEL` | Each independently defaults to `claude-opus-5-5`. |
| `GITHUB_TOKEN` | Optional host-side release-note requests. Public clone access stays anonymous. |

Keep credentials out of tool arguments, command flags, client config values, spawned repository commands and stored data. Bind the stub to the selected HTTPS origin, request route and credential header. Disable cross-origin redirects and end the binding with the authorized model phase. Separate changing hosts from rotating a key. Configuring a new origin requires setup for that origin. [Opus 5.5 model ID](https://platform.claude.com/docs/en/models/opus-5-5/overview) · [Runta secret stubs](https://runta.com/docs/runtime/secrets-and-secret-injection/)

Use the public role configuration from `agents-and-patches`. Construct host model handles for `releaseSummary` and `featureMatch` in the MCP process using its environment key and the configured model host. Pass serializable routes with stored-secret references for `repair` and `featureAdoption`. Validate required credentials on live start so saved evidence stays readable offline. All integration code for this change belongs in the MCP workspace. The separate `isolate-inspection-model-calls` proposal introduces the library option after `agents-and-patches` merges.

The library design also flags a gap between the pinned Runta SDK 0.2.0 and the documented runtime stub methods. Verify the tenant secret setter and stub lifecycle in the actual distribution before shipping. Supply the public library’s per-role pricing bounds for its cost reservations. Use published Anthropic bounds for the default route and require explicit price bounds for overrides whose costs are unknown.

### Client configuration

For the default host on macOS and Linux, setup prints the following single-line entries. Place the Claude entry inside `mcpServers` in the project's `.mcp.json`. Place the Codex entry at the TOML root in `~/.codex/config.toml`. In published builds pin the package spec in each line to the running setup version. The launcher runs the pinned npx command from the user’s home directory so a checkout cannot supply a local package. On Windows it uses `cmd.exe /d /c` and `%USERPROFILE%`. Launch the client with the named runtime variables available. Setup prints references to configured optional variables in Claude's `env` mapping and includes their names in Codex's forwarding list. Forward the host model key by environment variable name. This also works when setup and the client start in separate secret-manager sessions. [Claude Code config expansion](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson) · [Codex stdio environment forwarding](https://developers.openai.com/codex/mcp)

```json
"health-code": {"type":"stdio","command":"/bin/sh","args":["-c","cd \"$HOME\" && exec npx \"$@\"","npx","-y","health-code@0.1.0","mcp"],"env":{"RUNTA_TOKEN":"${RUNTA_TOKEN}","ANTHROPIC_API_KEY":"${ANTHROPIC_API_KEY}"}}
```

```toml
mcp_servers.health-code = { command = "/bin/sh", args = ["-c", 'cd "$HOME" && exec npx "$@"', "npx", "-y", "health-code@0.1.0", "mcp"], env_vars = ["RUNTA_TOKEN","ANTHROPIC_API_KEY"] }
```

### Patch handoff

Return the library-authored prompt with its tested artifact, prerequisite digests, apply order and base. Treat checkout reports, repository text and command output as untrusted evidence in any interpolation. Preserve fresh nonce fences and exact Patch bytes in separate fields. The client checks its own remote identity, HEAD and worktree status. It compares commits using local Git ancestry in both directions. A differing SHA alone gives no direction. The client can send its local comparison with the fetch and receives it labeled as client-supplied. With no comparison, the response reports unknown and instructs the agent to run the comparison before edits. Shallow or missing history can remain unknown. Never infer the client checkout from the stdio process working directory.

The handoff preserves uncommitted work, verifies each original byte digest, checks applicability, creates a new branch, applies prerequisites before the feature Patch, runs project typecheck and tests, and opens the authorized PR. If a Patch itself edits tests, stop and explain the conflict with this workflow. If the checkout has moved, disclose the relationship before edits and record adaptations. Report `clean` or `adapted`, require notes for adaptation, and distinguish `passed`, `failed` and `not_run`. Accept an optional validated HTTPS GitHub pull request URL for the target repository without fetching it.

## Risks / Trade-offs

- **Disconnected process.** In-flight Inspections are process-local. Show that lifetime in start output. The library handles graceful teardown and its own limits.
- **Secret-bearing failures.** Use controlled diagnostics and environment references in client configuration. Exercise tool results, progress, stderr, setup output and disk using synthetic sentinel values, including SDK failures containing the sentinel.
- **Large evidence.** Show a bounded summary and cursor, keep Sandbox Events pinned, and prove byte-for-byte retrieval of a multi-page Patch.

## Migration Plan

Build and verify against recorded evidence first. Enable real Inspections once the public library can satisfy every model role and Patch contract. Smoke-test both clients against the packed Node executable before publishing. Pin installed client configurations to a tested release. Roll back by restoring the previous client package version or removing its server entry. The home-directory evidence remains readable independently.
