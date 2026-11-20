# Engine foundation tasks

## 1. Package and evidence contract

- [x] 1.1 Configure the existing library workspace to build ESM and declarations with TypeScript 7. Verify a local npm tarball exports the public entry and excludes tests, fixtures, and build inputs. Keep both app manifests private.
- [x] 1.2 Define the options, provider, adapter, event, error, and Report Card types in the library. Compile a Node consumer against the emitted declarations, including a caller-supplied provider and reserved models.
- [x] 1.3 Implement per-inspection event collection, redaction, bounded delivery, typed rejection, and terminal ordering. Test concurrent callers, a throwing callback, and version 1 golden JSON replay with an extra optional field.
- [x] 1.4 Document the package entry, exports, folders, and build command in the root and library guides and README. Check each documented import and command against the packed artifact. Update the domain-model skill with approved terminology.

## 2. Provider contract and execution boundaries

- [x] 2.1 Implement the fake provider, recorded fixtures, and a shared provider contract suite. Verify file round-trips, buffered output, policy replacement, evidence scoping, timeout, and idempotent deletion with zero network requests.
- [x] 2.2 Implement the production provider using the verified SDK methods and bounded availability probe. Exercise missing token, HTTP 401/403, transient outage, and success against a stub transport. Confirm the probe never allocates a runtime.
- [x] 2.3 Implement trusted provisioning, URL validation, shallow acquisition, and commit verification. Test a moving branch, an unavailable private repository, and a fixture that would execute repository configuration before the lock if allowed.
- [x] 2.4 Implement full registry-policy replacement and readback, inherited-binding checks, and inert guest environment values. Test disallowed hosts, policy mismatch, static environment references, and absence of host credentials in guest inputs and output.
- [x] 2.5 Implement install observation and evidence collection. Test an attributable off-list attempt, ambiguous IP, confirmed denial, transient file write, symlinked destination, and incomplete observation. Assert the resulting finding and Sandbox Event separately.
- [x] 2.6 Implement disposable execution state, resource sizing, cost and deadline admission, and finally-block destruction. Inject cancellation, allocation-response loss, timeout, and deletion failure. Verify restored state, bounded retries, and the reported cleanup identifier.
- [x] 2.7 Add a credentialed instantiation of the same contract suite. Verify the no-token skip and the fake suite in preflight. Document the live test command, guest capability probes, and required credential in the library guide and README.

## 3. Node Ecosystem Adapter

- [x] 3.1 Detect the manager, version, lockfile, root, and workspaces. Cover all four managers, both Bun lockfile formats, Yarn generations, conflicting files, and pnpm workspace patterns with recorded manifests.
- [x] 3.2 Implement frozen Baseline install, registry discovery, and one-target manifest and lockfile updates. Verify lifecycle defaults, mixed workspace source versions, exclusion reasons, stable minor/major selection, and unchanged unrelated direct declarations.
- [x] 3.3 Implement config-aware typechecking and repository-owned test scripts. Verify local compiler selection, referenced projects, absent config, Bun/Vitest/Jest reporters, file-load failures, missing scripts, and exit-only results against fixtures.
- [x] 3.4 Document the adapter entry and supported project shapes in the library guide. Compare the documented manager, typecheck, and test combinations with the fixture matrix.

## 4. Inspection orchestration

- [x] 4.1 Connect the public inspection entry to provider and adapter selection. Test the Baseline and deterministic candidate cap under reordered registry responses, cap zero, and more than six eligible upgrades.
- [x] 4.2 Gate candidate checks on the Baseline and observed install. Verify a broken Baseline install or build, a dirty install, an unobservable install, and a clean install reused by the Upgrade Check.
- [x] 4.3 Implement Baseline exclusion, one confirmation per newly failing stage, and per-candidate restoration. Verify known, flaky, confirmed, and unidentifiable failures, plus a second candidate after a filesystem or process mutation.
- [x] 4.4 Assemble partial and complete cards with reasons, first and confirming evidence, and the terminal timeline. Verify live callback equality, deletion before success, budget exhaustion, and surfaced cleanup failure.
- [x] 4.5 Document the public call and its event, return, and rejection paths in the README and library guide. Execute the documented example against a fake provider in Node and Bun.

## 5. Integration verification

- [x] 5.1 Wire the packed-package smoke tests into preflight. Import and inspect a fixture in isolated Node and Bun consumers, compile its declaration consumer, and verify the complete repository preflight passes without credentials.
- [x] 5.2 Exercise the live provider contract and the two pinned public project fixtures in a credentialed environment. Record the exact pins, observation capability results, budget use, and acknowledged deletion. Report any missing production evidence explicitly.
- [x] 5.3 Run the repository boundary, structure, dependency, Knip, typecheck, and test gates through `bash scripts/preflight.sh`. Verify the module maps, README commands, and emitted package match the completed implementation.
- [x] 5.4 Add the development inspection CLI, document it in the README and module guides, and verify interactive progress, piped output, fake replay, and the saved JSON.

### Live verification on November 20, 2026

The provider contract passed in 55.8 seconds. It checked registry access, an off-list connection attempt, a transient file write, command timeout, and acknowledged deletion.

| Public repository | Pinned commit | Baseline install | Inspection duration | Estimated cost ceiling | Sandbox deletion |
| --- | --- | --- | --- | --- | --- |
| ai/nanoid | `055d1700cc67ac843e3efb5235d806b419ec7b2b` | Passed | 37.4 s | $0.003221 | Acknowledged |
| privatenumber/get-tsconfig | `b4e7751e408eeaf014974a7cb1ec2634914a4d6c` | Passed | 44.0 s | $0.003221 | Acknowledged |

A separate inspection of nanoid installed `@size-limit/preset-small-lib@14.3.0`. The Install Check returned untested because observation was incomplete. The timeline acknowledged deletion after 57.0 seconds. The cost figures above use the provider estimate for elapsed time.
