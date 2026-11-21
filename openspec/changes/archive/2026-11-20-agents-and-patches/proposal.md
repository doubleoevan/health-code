# Agents and patches for Health Code

## Why

Health Code can tell a maintainer whether a dependency upgrade passed inspection. Reading the intervening releases and matching a new feature to the maintainer's own code lets it offer a tested simplification worth adopting.

## What Changes

- For each selected Upgrade, read the intervening releases, identify usage in the pinned Repository, and cite the code a feature could replace. Show breaking changes, diagnostics and the change in installed size.
- Let a caller supply four model roles. Summaries and matching use the caller's process. A repair gets up to 40 turns, 20 minutes and $4. Feature adoption gets 25 turns, 10 minutes and $2. The version 2 Inspection gets 60 minutes and $15 total. Repair and feature adoption replies allow up to 8,192 output tokens. Callers can lower the time, dollar and turn caps.
- Before either Agent Attempt starts, verify the scoped credential against the live model route. The Runta provider sets the stub through the same HTTP request as its CLI.
- Accept a Patch only after an independent final check verifies the changes, test inventory, installation and network evidence. Export the tested upgrade series and an optional feature series that applies on top.
- Extend the Report Card with evidence-backed Verdicts, reviewable commits, application instructions and step costs. Preserve the existing public call, event stream and stored version 1 cards for existing consumers.
- Add a separately invoked evaluation set for the historical TypeScript break and the CarlNotes Baseline. Record the first pinned CarlNotes measurement in the case file for review. Keep scoring read-only and preflight offline.

## Capabilities

### New Capabilities

- `feature-matching` pairs cited release changes with code in the inspected Repository and ranks adoption opportunities.
- `agent-attempts` governs model roles, bounded repair and feature adoption, and evidence for accepting an edit.
- `tested-patches` governs the final check, commit series, export and consumer handoff.
- `inspection-evaluations` defines reproducible cases and report-only scoring.

### Modified Capabilities

- `inspection-contract` adds opt-in model execution, progress and version 2 Report Cards while retaining check-only inspections.
- `sandbox-execution` adds a scoped, temporary agent credential binding and verified phase-specific egress.
- `node-ecosystem` adds a usage map, pinned diagnostics, comparable size measurements and test inventories.
- `upgrade-inspection` coordinates selected upgrades, fixes and feature adoption and assigns one final Verdict per Upgrade.

## Impact

The library owns these behaviors behind its public entry. The live and fake Sandbox Providers implement the capability independently. The site and CarlNotes choose routing, prices and delivery. An inspection returns patch bytes and instructions. A consumer or its user decides whether to apply, fork or publish them.
