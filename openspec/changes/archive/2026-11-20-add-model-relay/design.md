# Model Request Sandbox for release summaries and Feature Matches

## Context

MCP setup writes one stored secret per model origin. Before the Model Request Sandbox, `apps/mcp/configureModels.ts` also constructed two authenticated model handles in the MCP process. In the library, `inspectModels.ts` builds the prompt, reserves the call, dispatches it, then validates citations and source locations. Only dispatch needs a second route.

## Goals / Non-Goals

The MCP process needs only its sandbox account token after setup. Existing web and CarlNotes callers own their local models. Repository acquisition, release fetching, prompt construction, citation checks and ranking stay in their current locations. Repair and Feature adoption retain their existing execution and credential contracts.

## Decisions for approval

| Decision | Recommendation | Reason |
| --- | --- | --- |
| How to send requests | Reuse one runtime per Inspection. Start a trusted, one-shot helper through provider exec for each model request. | A persistent service would require a listener, request correlation and restart handling. Each existing call already has a deadline and a usage receipt. |
| Size and timeout | 1 vCPU, 512 MiB requested and maximum memory. Allow up to 60 seconds for cold startup and 120 seconds per model request sandbox call. Clamp both to the remaining Inspection work budget. | The helper handles one bounded inference at a time. Local caller-side requests retain their 45-second cap. Measure the proposed memory and startup budget against the real image before shipping. |
| Batching | Keep one summary per eligible Upgrade, then one matching call if pinned usage exists. Reuse the model request sandbox across Upgrades. | Matching consumes that Upgrade’s validated summary. Combining calls would couple citations, failure handling and per-role pricing. Skip both calls when release evidence is absent. |
| API and MCP config | Add the library option `callerModelExecution: "local" \| "modelRequestSandbox"`. Omission selects `"local"`. The MCP sets `"modelRequestSandbox"` internally. | The name scopes the choice to the two caller-side roles. A developer pastes a token-only client configuration without choosing another mode. |

Runta’s CLI documents a 1-vCPU, 512-MiB runtime. Live verification measured 22.584 seconds from release evidence to verified startup and a sampled guest memory peak of 99.2 MiB at the approved size. [Runtime commands](https://runta.com/docs/reference/cli/runtime-commands/)

### Public contract and request path

Keep the current `InspectionModels` and options valid for local callers. Add a discriminated options branch for model request sandbox calls. Its `releaseSummary` and `featureMatch` take serializable model routes with the existing protocol, base URL, model ID, stored credential reference and pricing. Both guest roles keep their present shape. Reject mixed handles and routes, missing model request sandbox support, and invalid route or pricing before allocating anything. Omitted models and legacy string dictionaries still produce version 1. Type the model request sandbox event on the opt-in overload so existing exhaustive local callbacks still compile. Consumers that replay arbitrary cards accept the additional version 2 action.

The MCP makes its choice at the public library entry:

```ts
inspectRepository({
  repositoryUrl,
  sandboxProvider,
  callerModelExecution: "modelRequestSandbox",
  models: { releaseSummary: summaryRoute, featureMatch: matchRoute, repair: repairRoute, featureAdoption: adoptionRoute },
})
```

Give `SandboxProvider` an optional `modelRequestSandbox` capability. It quotes runtime cost, opens a model request sandbox under a caller-supplied allocation identity, sends a bounded model request with an attached credential, and closes or reconciles the named allocation. The engine owns the deadline, prompt, role and ledger. The provider owns transport, bindings and the runtime. The fake records lifecycle, inert route and request evidence and returns scripted replies or faults.

Build each prompt once with the existing versioned template, redaction, size bounds and fresh nonce fences. Fenced release text, source excerpts and the prior summary are data. Send only the finished prompt, trusted route and output ceiling to the helper. Return bounded text, model ID, request ID and usage to the same response validators as local mode. Preserve the 1,024-output-token caller-side limit. The separate 8,192-token Agent Attempt limit still applies only to the two editing roles.

### Credential boundary

Create a separate runtime with closed egress. Supply the trusted helper and its runtime dependencies through the provider control plane or a trusted image. Its filesystem has no checkout, shared project volume, package installation or agent tools. It has no public ingress, inbound listener, caller environment or model credentials. Supply request data through a bounded structured input, with a fixed executable and no prompt interpolation into commands.

Before dispatch, replace and read back the complete egress allowlist for the one active model host. Reuse `setCredentialBinding`, including its revision-checked HTTP adapter and existing SDK migration note. Verify the exact HTTPS origin, protocol path, header template and stored reference. Only the gateway substitutes the real key. Reject redirects and send no model request when verification fails. Serialize route changes and fully revoke the previous binding before selecting another. The repository sandbox keeps its own policy throughout. A model request sandbox failure never selects local authentication.

### Lifecycle, recovery and evidence

Record the intended model request sandbox identity before create so a lost create reply can be reconciled. Open it lazily after cost admission, once per Inspection, including simultaneous first requests. Immediately after verifying the first route, emit one version 2 Sandbox Event, `model-request-sandbox-started`, with the model request sandbox ID and Inspection ID. Pin it in the live log and timeline. The recorded detail explains that the sandbox provider supplies the model key and the caller’s machine does not need it. The event attests to the route used, even when a user still has an old environment setting.

Attach both cleanup obligations to the Inspection’s outer `finally`. Revoke the binding and attempt deletion of both resources, independently, under a reserved cleanup budget. Handle success, cancellation, callback failure, partial creation and lost replies. Record confirmed deletions against their respective IDs. Preserve each unresolved ID on the typed failure alongside the existing single-ID compatibility field. Emit the terminal event after these attempts.

Name the sibling `<existing inspection runtime name>-relay`. The launch reaper uses one exact parser for `hc-site-<deployment>-<uuid>` and its model request sandbox sibling. Use the embedded Inspection UUID to protect both while live. Preserve the site reaper’s deployment boundary. For personal MCP names (`health-code-<uuid>-relay`), record the intended name under the MCP’s private storage before allocation. On restart reconcile only recorded names from a confirmed dead owner. Use a process-lifetime ownership lock so concurrent local MCP sessions sharing the account cannot reclaim one another’s work. Apply equivalent ownership and cleanup to the short-lived setup probe. A provider request timeout can leave a runtime allocated. Reconcile its identity until deletion is confirmed. The parallel launch proposal adds periodic recovery and cost reporting. Both changes must consume the same name parser and runtime accounting, in either landing order.

### Time and spend

The default Inspection deadline is 60 minutes. A model request sandbox created later uses only the remaining work window. Hold back time for deletion before dispatching work. If the host resumes after the deadline, cleanup gets one bounded grace period. Price that grace separately for each allocated runtime and record actual elapsed time through confirmed deletion. A runtime with unconfirmed deletion retains its cleanup identity and an incomplete total. Reserve both runtime bounds and cleanup before creating the model request sandbox and reserve each model charge before dispatch. If the remaining budget cannot fund the model request sandbox, issue no create or paid request. Give setup 120 seconds total, including provisioning, the single probe and cleanup. Reserve its maximum model and runtime cost before allocation, independently of Inspection accounting.

Add optional inspection-level `runtimeUsage` to the version 2 Report Card. Each entry identifies the repository sandbox or Model Request Sandbox, its observed lifetime in milliseconds and the billed cost if available, otherwise a labelled USD upper bound. Measure model request sandbox time from allocation through confirmed deletion, including idle intervals. Round each runtime independently using its provider’s resource rates. Include both runtime entries once in the total with metered model costs and outstanding model reservations. Preserve an upper bound when a receipt or cleanup confirmation is missing. If the provider may still be billing, mark the total incomplete and identify the accounting cutoff. Never present a reservation as a final bill. Older cards can omit the field. An unallocated model request sandbox contributes zero.

### MCP setup and migration

With `RUNTA_TOKEN` alone, setup locates the existing origin-bound secret. A one-time setup key can create or rotate it. If the selected origin has no stored secret, explain how to register one. Never request the stored secret value. Before printing success, use the same model request sandbox path to send one authenticated, one-output-token probe with a fixed innocuous prompt. Confirm cleanup. A failed probe returns an actionable redacted error and emits no success configuration.

Keep the existing pinned launch command in each client. At default settings the generated credential sections read:

```json
{ "env": { "RUNTA_TOKEN": "${RUNTA_TOKEN}" } }
```

```toml
env_vars = ["RUNTA_TOKEN"]
```

User-selected nonsecret route, model and pricing overrides remain available. An optional GitHub credential still serves release retrieval only and requires separate opt-in. Existing users can re-run setup using the stored key, replace their client entry, remove the local model-key reference and restart. The MCP ignores an inherited model key during live Inspections. Document that a user can remove their own saved copy after successful setup. The web and CarlNotes can upgrade the library without changing options or secrets.

## Risks / Trade-offs

- **Cold startup and exec overhead.** Measure cold startup, warm exec time, peak memory and total model request sandbox lifetime with the packed helper. Measure the setup probe and two sequential model calls separately.
- **Uncertain billing or deletion.** Retain the pre-dispatch bound, stop conflicting work and expose the cleanup identity. Retrying an ambiguous model request could charge the user twice.
- **Packaging drift.** Exercise the packed artifact under Node and Bun and run a credentialed provider check before release. Preflight uses the fake provider.
- **Rollout.** Ship the compatible library and MCP together. Verify the stored secret and new client config before removing the old key reference. A user who deliberately downgrades to a local-key MCP version must restore that version’s documented credentials.
