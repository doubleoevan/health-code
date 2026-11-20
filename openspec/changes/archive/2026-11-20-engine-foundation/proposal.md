# Proposal

## Why

A maintainer needs to know whether a dependency upgrade breaks this repository at this commit, and what the installer attempted along the way. The site, MCP server, and scheduled callers need the same evidence from one library.

## What Changes

- Expose a Node- and Bun-compatible ESM package named `health-code` with declarations, a single inspection call, ordered events, and a versioned JSON Report Card. Consumers own persistence.
- Pin a public GitHub repository, establish its Baseline, observe each candidate install under a registry-only network policy, and confirm new failures before attributing them to an Upgrade.
- Put sandbox operations behind a provider contract and language behavior behind an Ecosystem Adapter. Ship a production provider and a deterministic fake. Keep the site and MCP workspaces as placeholders.
- Make incomplete observation, unsupported projects, provider outages, and exhausted limits visible. Reserve model configuration for a later change. Agents, release notes, Verdicts, and Patches belong to that later change.

- Add a development CLI that consumes the public library, displays progress, and saves a local Report Card.

## Capabilities

### New Capabilities

- `inspection-contract` — public library entry, caller options, Inspection Events, errors, and Report Card compatibility.
- `sandbox-execution` — isolated execution, credential availability, staged network policy, installation evidence, and teardown.
- `node-ecosystem` — workspace and package-manager detection, dependency discovery and updates, typechecks, and test evidence.
- `upgrade-inspection` — bounded candidate selection, Baseline comparison, Install Check gating, and confirmation of regressions.

## Impact

Most implementation belongs in the existing `packages/health-code` workspace. Its manifest currently has private visibility and an empty exports map. A package build, packed-artifact smoke test, provider contracts, and recorded fixtures enter preflight. The release process can publish the resulting tarball separately.

The library will use the existing TypeScript 7 toolchain. Update the module guides, README Development section, and domain vocabulary with the implementation.
