# Isolated model routing

## Context

The initial MCP release supplies two authenticated host model handles and two serializable Agent Attempt routes. Setup stores a model key in Runta under a name derived from the configured model origin. Implement this follow-up after the four-role API from `agents-and-patches` merges.

## Goals / Non-Goals

A live MCP Inspection needs only the developer’s sandbox token and registered model secret at default settings. Other library consumers can continue supplying authenticated host handles. The change covers outbound model requests for release summaries and Feature Matches. Release-note retrieval, prompt construction and result validation stay in their existing locations.

## Decisions

Extend the public inspection options with an optional discriminator, proposed as `modelExecution: "isolated"`. Omission keeps the existing host-handle contract. Selecting isolation requires serializable routes for `releaseSummary` and `featureMatch`, using the same protocol, endpoint, model ID, credential reference and pricing fields already used by the two guest roles. Reject mixed modes before allocating resources. Keep legacy model-free calls valid.

Have the library lazily acquire one provider-owned inference runtime per Inspection. It receives bounded requests from the library and returns model output and usage. It runs trusted library code without a Repository checkout, Repository commands or the developer’s process environment. Bind only the role’s allowed model endpoint and header, verify egress and stub state, and prevent cross-origin redirects. Scope each binding to its request and revoke it on exit. The gateway substitutes the stored key outside the runtime.

Keep the pre-call reservation and cancellation signal with the Inspection. Include runtime cost, model usage and cleanup time in the same budgets as the rest of the work. On a failed binding, surface a typed failure. If a dispatched request loses its response, retain its cost reservation. Clean up on every exit path.

The MCP opts in through the package entry and supplies its existing secret reference for all model routes. Setup retains its secret write and rotation behavior. Remove the model key from both emitted client configs. Existing users with the correct stored secret can replace their config and restart the client without uploading the key again.

## Risks / Trade-offs

An extra runtime consumes startup time and budget. Allocate it only for Inspections that need one of the two roles and reuse it across their calls. Verify the remaining budget covers teardown before dispatch. Test that a failure never attempts direct host authentication, even if the environment contains an old key.

## Migration Plan

Reconcile the deltas with the merged library and MCP specs. Release the backwards-compatible library first. Pin that version in the MCP release, enable the option and update its configuration examples. Keep old cards and tool IDs readable. To roll back the MCP, restore the earlier package pin and its environment reference for the model key.
