# Engine foundation design

## Context

Review the public contract, upgrade selection, Install Check observation, sandbox reuse, test projects, and execution limits before approving implementation. The proposal names the four capabilities these decisions support.

The library, site, and MCP workspaces already exist. The library currently has an empty exports map and inherits a declaration-only TypeScript build. Its callers will include a website, an MCP server started through npm, and a scheduled Temporal activity.

## Goals / Non-Goals

Each caller can display an inspection live, persist its Report Card, and replay the same events. The library owns inspection state for the duration of one call. Consumers own storage, scheduling, retries across inspections, and presentation. Agent Attempts, model calls, release notes, Verdicts, and Patches belong to the next change.

## Decisions

### 1. One entry point and a versioned evidence contract

Export `inspectRepository(options: InspectionOptions): Promise<ReportCard>`, the types below, and the factories `createSandboxProvider` and `createFakeSandboxProvider` from `health-code`. A caller can use its own structural provider. Construct the shipped provider explicitly to keep importing the package free of credential lookups.

| InspectionOptions field | Contract |
| --- | --- |
| `repositoryUrl: string` | Public HTTPS GitHub owner/repository URL. Normalize an optional trailing slash or `.git`. Reject credentials, ports, query, fragment, branch paths, and other hosts. |
| `sandboxProvider: SandboxProvider` | Required. The caller owns the provider, each inspection owns the sandboxes it allocates. |
| `limits?: InspectionLimits` | Optional overrides for `maxUpgrades`, `maxDurationMs`, `maxCostUsd`, and per-step timeouts. Validate finite nonnegative budgets and integer counts before allocation. |
| `onEvent?: (event: InspectionEvent) => void \| Promise<void>` | Await callbacks in sequence. Consumers can persist or stream copies. Enforce the remaining deadline on delivery. |
| `models?: Readonly<Record<string, string>>` | Reserved role-to-model identifiers. Accept and ignore them in this version. |
| `signal?: AbortSignal` | Stop scheduled work on cancellation. Cleanup has an independent deadline. |

Every event carries `version: 1`, `inspectionId`, a one-based `sequence`, an ISO UTC `timestamp`, and a discriminating `type`. Step-scoped events include `stepId` and an upgrade identifier when applicable. One collector appends each event before delivering a copy. A callback error stops scheduling, preserves evidence and initiates cleanup. The typed rejection includes the terminal timeline even if delivery failed. If delivery of the terminal event itself fails, attach that same terminal timeline to the delivery error.

| Event type | Payload |
| --- | --- |
| `inspection.started` | Normalized repository URL |
| `step.started` | Step ID and human-readable label |
| `step.finished` | Same ID, summary, status, and duration in milliseconds |
| `detail` | Step ID, output stream, redacted text, truncated flag |
| `sandbox.event` | Sandbox ID, action and evidence. Actions include `created`, `credentials-withheld`, `network-locked`, `connection-blocked`, and `deleted`. The credential action records applying and verifying the guest credential controls. |
| `inspection.finished` | Upgrade counts and elapsed time. The event contains no copy of the card. |
| `inspection.failed` | Stable error code and bounded message, plus cleanup status if relevant |

Highlight and pin every Sandbox Event in consumers. Record an observed attempt without a confirmed block in the Install Check findings. A future agent-start action can carry the key-withheld evidence when an Agent Attempt actually starts.

`ReportCard` carries `version: 1`, `inspectionId`, `repository: { url, commit }`, `packageManager` (name/version or detection reason), `baseline`, `selection`, `upgrades`, and `timeline`. Each upgrade includes dependency, source versions by declaring workspace, target version, Install Check, typecheck, tests, and overall Check Result. Preserve first and confirming evidence, including Baseline exclusions.

`CheckResult` is a tagged union with `status` equal to `passed`, `failed`, or `untested`. Passed includes the checks performed. Failed carries `failingTests` and diagnostic or exit evidence for a non-test failure. Untested carries a machine-readable reason and human-readable detail. Report an inapplicable typecheck as untested with reason `no-tsconfig`. Missing tests leave an otherwise successful upgrade untested.

Add optional fields to version 1. Readers ignore unknown fields and preserve unknown event kinds on replay. Changing required fields or the meaning of a status needs a new schema version. A golden JSON card and an old-reader fixture cover compatibility. This contract lets a scheduled consumer store the same artifact as the site without adopting a library-owned database.

Reject fatal inspection errors as `InspectionError` with a stable code and timeline. `SandboxUnavailableError` specializes it for missing or rejected credentials, denied access, or provider unavailability. Distinguish transport failures from authentication in the reason. After a repository is pinned, evidence gaps normally return a partial card. Cancellation, lost provider control, callback failure, and unresolved teardown reject with available evidence.

### 2. Six upgrades, inspected sequentially

Read the root manifest and expanded workspaces. Resolve registry declarations in dependencies, devDependencies, peerDependencies, and optionalDependencies against the committed lockfile. Keep every declaration and original resolution. Record local, Git, unresolved, and unsupported sources with a discovery reason.

For each dependency, use the highest locked version across its declaring workspaces as the lower bound. Choose the latest stable release in a higher minor of that major and the latest stable release in a higher major. Omit patch-only changes and prereleases. Each selected target must advance every declaring workspace. Record mixed starting versions in the Report Card.

Deduplicate by dependency and target. Order minor upgrades first, then majors, sorting each group by dependency name in ordinal order. Default to six pairs. A cap of zero collects the Baseline only. Record omitted pairs and the cap separately from candidates whose checks are untested. This ordering favors smaller changes and makes selection reproducible from the same registry evidence. An exhaustive default would let the dependency count determine cost.

### 3. Registry-only installation with attributable evidence

The provider contract exposes `checkAvailability`, `estimateMaxCost`, `createSandbox`, `executeCommand`, `writeFile`, `readFile`, `setNetworkPolicy`, `readAttemptedConnections`, `readFileChanges`, and `destroySandbox`. Observed executions return an evidence identifier and coverage status. The provider owns the observer lifecycle. Checks receive sandbox handles, command arguments, deadlines, and plain evidence types. Vendor SDK objects stay inside their provider.

| Provider operation | Production mapping |
| --- | --- |
| Authenticate | The constructor accepts a token or defaults to `RUNTA_TOKEN`. Reject an empty token. The probe uses one authenticated `GET /v2/runtimes?limit=1` and discards the response body. It creates no runtime. [List runtimes](https://runta.com/docs/reference/api/operations/listruntimes/) |
| Allocate and reconcile | Use `client.runtimes.create(name, { vcpus, memoryMib, memoryMaxMib })`. Generate the unique name before allocation. Resolve an ambiguous response through `client.runtimes.get(name)`. Map SDK configuration and HTTP errors at this boundary. [Runtime manager](https://runta.com/docs/reference/sdk/typescript/api/managers/runtimes/) |
| Command and files | Use `runtime.exec(argv, { cwd, env, timeoutSecs, maxOutputBytes })`; collect `exitCode`, `stdoutText`, `stderrText`, `durationMs`, and both truncation flags. Use `runtime.files.write` and `readText` or `read` for artifacts. The SDK also provides upload and download. [Command model](https://runta.com/docs/reference/sdk/typescript/api/shared/runtime-models/) · [Files](https://runta.com/docs/reference/sdk/typescript/api/managers/files/) |
| Credentials and network | Read the runtime’s `secret_configuration` from its authenticated v2 detail endpoint for inherited bindings. Require a clean runtime and a sanitized guest environment before executing the repository. Use `runtime.egress.setPolicy` with the complete allowlist, then compare its normalized readback through `runtime.egress.get()`. [Runtime configuration](https://runta.com/docs/reference/api/operations/getruntime/) · [Egress](https://runta.com/docs/runtime/egress/) |
| Release | Call `runtime.delete()` in a finally block. Treat verified absence as success. Bound retries and retain the allocation ID or unique name on failure. [Runtime lifecycle](https://runta.com/docs/reference/sdk/typescript/api/core/runtime/) |

Use trusted provisioning to install or verify pinned Git, Node, Bun, package managers, and observation tools in the open-network phase. Resolve the public default branch without credentials. Shallow-fetch its commit and verify the checkout against that full ID. Read manifests and lockfiles as data. Disable Git hooks, submodule recursion and external checkout filters. Keep repository code and configuration from executing during setup.

Replace the policy with `registry.npmjs.org`, `registry.yarnpkg.com`, and any reviewed public registry host required by the selected manager. Repository settings cannot extend it. GitHub access ends at this point. Start repository commands with an explicit guest environment. Read variable names from the example environment file and static environment references, including string-literal property access. Supply inert values, keep trusted control variables reserved, and report dynamic names as unknown. Never ingest example values, host secrets, or real dotenv files.

The documented organization events expose a free-form kind and payload. The reference specifies no denied-host record. Use protected guest observation as the initial evidence source. Accept authoritative provider denials if a documented, tested feed becomes available. [Organization runtime events](https://runta.com/docs/reference/api/operations/listorganizationevents/)

Observe the installer and its descendants from a separate privileged supervisor. Use network syscall tracing and scoped DNS query/answer logging to correlate attempted endpoints with hostnames and timestamps. Retain raw IP evidence when the mapping is absent or ambiguous. DNS lookup alone does not prove a block. Emit a blocked Sandbox Event only for an attributable denial, such as a documented gateway rejection. Report an attributable off-list attempt even if its outcome is unknown.

Trace successful filesystem mutations across the process tree, including renames, deletions and writes to open files. Resolve paths against the process working directory and file descriptors, accounting for symlinks. Record transient outside-project writes as well as surviving files. Put ordinary manager cache, home, and temp paths inside the isolated project for each check. Protect observer logs from the repository user. A private network namespace reaches the registry gateway through user-mode networking. The guest uses the runtime’s public CA bundle for registry TLS. Record names and paths with bounded counts, without payloads or file contents. Overflow, lost descendants, or observer self-test failure makes coverage incomplete.

### 4. A fresh sandbox per inspection, without a reusable checkpoint

Provision a fresh runtime for each inspection. Keep the pinned source and trusted tools in a guest area the repository user cannot modify. Execute each baseline or candidate from a disposable copy, with fresh caches, home, temp paths, and a supervised process group. Keep writes elsewhere confined to that execution's disposable filesystem view. Verify teardown of descendants and discard the writable view between candidates. A Git reset alone cannot restore these inputs.

Start each candidate by changing the declarations and observing the entire install, including lockfile regeneration and lifecycle work. A clean Install Check provides the bump and installation evidence for that candidate's Upgrade Check. Continue with typecheck and tests in that exact tree. Avoid a second unobserved install. If restoration cannot be verified, destroy the runtime before another candidate or record the rest as untested.

Provider checkpoints would save provisioning time but introduce retained state, invalidation, and billed storage. Measure setup duration from step events first. Never pause a sandbox between checks or calls. [Runtime billing states](https://runta.com/pricing/)

### 5. Local fixtures and two pinned public repositories

Keep fixture projects and canned transcripts under the library's `test/fixtures/recorded/`. The fake provider accepts caller-supplied fixture data, enforces phase and command expectations, and returns deterministic evidence without executing untrusted scripts on the host.

| Fixture | Evidence it exercises |
| --- | --- |
| npm JavaScript project with Jest | Frozen install, lifecycle attempt to an unlisted host, a transient outside-project write, clean comparison |
| pnpm TypeScript workspace with Vitest | Shared declarations, JSONC/project references, Baseline failure, new confirmed failure, file-load failure |
| Bun TypeScript project | Text and binary lockfile variants, Bun test reporting, a flaky test and retry |
| Yarn JavaScript project | Classic and modern lockfile variants, missing compiler config, script with only exit-code evidence |

Share one provider contract suite with a fake and a credentialed production instantiation. Test authentication, file round-trip, buffered output, policy readback, observation self-tests, timeout, and teardown. The real cases skip when the test harness lacks `RUNTA_TOKEN`. Production contract tests use controlled fixtures for expected denials and filesystem writes. Preserve recorded probe outputs without token values or host file contents.

Use `ai/nanoid` at `055d1700cc67ac843e3efb5235d806b419ec7b2b` for JavaScript, and `privatenumber/get-tsconfig` at `b4e7751e408eeaf014974a7cb1ec2634914a4d6c` for TypeScript. Exercise pinned acquisition and a bounded Baseline in live smoke tests. Assert the pin, evidence shape, and deletion across upstream test outcomes. The harness supplies fixed commits internally; public inspections still resolve default-branch HEAD. [Nano ID fixture](https://github.com/ai/nanoid/tree/055d1700cc67ac843e3efb5235d806b419ec7b2b) · [get-tsconfig fixture](https://github.com/privatenumber/get-tsconfig/tree/b4e7751e408eeaf014974a7cb1ec2634914a4d6c)

### 6. Fixed resources and bounded work

Start with **2 vCPUs, 4 GiB memory, 30 minutes total, and US$0.25 per inspection**. These are proposed defaults for small repositories. They bound sequential work and leave room for a compiler and test runner in one runtime. Use the smaller of each step's ceiling and the remaining inspection budget.

| Step | Default ceiling |
| --- | --- |
| Credential check or policy verification | 10 seconds per request |
| Allocate, provision, and clone | 5 minutes combined |
| Detect project and discover upgrades | 60 seconds combined |
| Install, including candidate bump and lockfile update | 3 minutes |
| Typecheck | 2 minutes |
| Tests | 3 minutes |
| Confirm a failure | Same limit as the failing step |
| Destroy and reconcile | Reserve 60 seconds within the total |

The provider supplies a conservative cost bound for fixed CPU, memory, and disk allocation. Derive an affordable deadline before creation, account for billing granularity and cleanup, and refuse a cap the provider cannot bound. Use integer monetary units internally. A budget expiration stops new work, marks remaining checks untested, and triggers deletion. A lost deletion acknowledgement produces an explicit cleanup error with the owner-visible resource ID. [Provider rates](https://runta.com/pricing/)

## Comparing checks

The Node adapter supplies `detectProject`, `install`, `bumpDependency`, `typecheck`, `test`, and `listUpgrades`. Language-specific commands and parsing live there. The engine owns sequencing and evidence comparison. Registering a future language adds one adapter implementation and its registration.

Resolve an ambiguous root lockfile using the committed `packageManager` declaration when it agrees with a lockfile. Detect pnpm workspace YAML and package manifest workspace patterns. Baseline uses npm `ci`, Bun or pnpm frozen install, or Yarn's generation-appropriate immutable/frozen install. Respect the manager's normal lifecycle policy. Use the repository's local TypeScript compiler and effective project config.

Invoke the repository's test script with a machine-readable reporter for recognized Bun, Vitest, and Jest commands. Preserve script setup, options, and workspace context. Use the unchanged script and exit code when wrapping prevents reliable reporter selection. Identify tests by workspace, relative path, and full suite/test name. Identify a load failure by workspace and file. Flag truncated or malformed reports as incomplete.

Run the Baseline before upgrade trials. Discover eligible upgrades from committed data even when frozen install fails, wherever the lockfile supplies usable versions. A failed Baseline install or required build blocks every selected candidate. A Baseline test failure excludes the matching identities only. A failed opaque Baseline test command prevents attribution when the upgraded command also fails.

Confirm each newly failing stage once with the same candidate inputs and policy. Rerun the test script for newly failing tests. Compare normalized compiler diagnostics or install error evidence when those stages fail. An Install Check policy finding stops the candidate at once. A confirmed new failure yields failed. Incomplete evidence or solely unconfirmed failures yield untested. A fully observed clean install and comparable passing checks yield passed, with any excluded Baseline failures listed.

## Risks / Trade-offs

| Risk | Response |
| --- | --- |
| The base image or guest privileges cannot support protected observation or disposable writable state. | Probe capabilities against a controlled fixture. Return incomplete coverage or end the inspection when isolation cannot be established. Gate production support on live contract evidence. |
| DNS observations, encrypted traffic or opaque test scripts limit attribution. | Preserve the observed granularity. Return untested when the outcome depends on missing evidence. |
| Commands print large output or credential-shaped text. | Bound each stream to 64 KiB per command, redact before callbacks and storage, and retain truncation flags. Parse structured reports from size-limited files separately. |
| A retry duplicates side effects or loses deletion confirmation. | Reconcile the unique allocation name, confirm absence, and return cleanup status with the original failure. A scheduled caller can use the identifier to reconcile ownership. |

## Migration plan

Expose the library through compiled ESM and declarations at its existing workspace root. Add a dedicated emit configuration for the published artifact and package only distribution files and metadata. Keep Bun-specific APIs in development tooling. Before publication, pack locally and load the tarball from fresh Node and Bun consumers, including a TypeScript declaration check. Preflight uses the fake provider and needs no credentials.

Update the library guide, affected root maps, README Development commands, and the domain glossary alongside implementation. An **Installation Finding** records one observed connection attempt or filesystem change attributed to an Install Check, with its source and coverage. Keep the established meaning of **Sandbox Event**. Package publication and consumer rollout are separate actions.
