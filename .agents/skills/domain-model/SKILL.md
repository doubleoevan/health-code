---
name: domain-model
description: Names Health Code entities when writing or reviewing types, files, events, tools, specs, prompts, and customer copy.
---

# Health Code domain model

An **Inspection** targets a **Repository** at one inspected commit. An **Ecosystem Adapter** supplies the language-specific commands, and a **Sandbox Provider** supplies the environment. The **Baseline** establishes which tests already fail. For each **Upgrade**, the **Install Check** observes installation and the **Upgrade Check** compares the changed dependency against the Baseline. Each check yields a **Check Result**. An **Agent Attempt** can repair a broken Upgrade or adopt a **Code Feature Match** and produce a tested **Patch**. The **Inspection Report** records the per-upgrade **Verdict**, evidence, patches, and timeline of **Inspection Events**, highlighting each **Sandbox Event**.

| Entity | What it is | Notes |
| --- | --- | --- |
| Repository | A public GitHub repository an Inspection targets. | Resolve one commit for each Inspection. |
| Inspection | One end-to-end check of a Repository at an inspected commit. | Produces one Inspection Report. |
| Baseline | The install, typecheck, and tests on the Repository before any change. | Exclude tests that fail here when attributing failures to an Upgrade. |
| Upgrade | Moving one dependency from its current version to a newer one. | Identify the dependency and both versions. |
| Upgrade menu | The targets offered for direct dependencies at a Repository commit, chosen from their eligible dependency versions. | Use upgrade menu in copy and upgradeMenuId when a caller opens, pages or selects from a saved upgrade menu. |
| Locked dependencies | The locked version of each direct dependency per workspace at a Repository commit, with the dependencies skipped for an unsupported or unresolved source. | The Guest reads them from the checkout and the upgrade menu reads them from GitHub, through one implementation. Name the type `LockedDependencies`. |
| Linked dependency | A declared dependency upgraded in the same Patch because the packages must move together. | Check it with its Upgrade and list it under **Dependency changes**. |
| Minimum release age | The repository’s package manager setting for how old a release must be before install. | Offer only releases old enough to install. |
| Named version | One dependency version a caller names to test, which the upgrade menu may not list. | Check it against the rule for an eligible dependency version. Use named version in code and copy. |
| Eligible dependency version | A dependency version the target rule accepts: published, stable, not deprecated, newer than the highest locked version and old enough for the minimum release age. | Patch releases qualify, so the eligible dependency versions include more than the upgrade menu's targets. List them under `eligibleDependencyVersions` when a named version is rejected. Customer copy may say eligible versions beside the dependency's name. |
| Unreadable repository | A Repository whose committed files the upgrade menu cannot read through GitHub: a binary lockfile, a truncated tree, a symbolic link or a file past a limit. | Return the reason under `unreadable` and offer the sandbox listing. |
| Sandbox listing | The eligible upgrades a sandbox lists from a checkout, with `mode: "listUpgrades"`. | Use it for an unreadable repository. It returns an Inspection Report with no Upgrade tested. |
| Declared package manager version | The exact package manager version a Repository's committed files declare, in `packageManager`, `devEngines.packageManager`, `engines` or Bun's `.bun-version`. | A range declares no version. Install a declared version inside the supported range before any Repository file runs. Name the value with its source `DeclaredPackageManager`. |
| Bundled package manager version | The package manager version the sandbox ships and runs when the Repository declares none or its declared version cannot be installed. | Record `packageManager.source` as `declared` or `bundled` in the Inspection Report, with `declared` and `fallbackReason`. |
| Release feature | A change described in a dependency’s release notes. | Use “What’s new” in the upgrade menu. Cite the release. A Code Feature Match also identifies where the change applies in the Repository. |
| Install Check | Installation of an Upgrade with the network locked to package registries. | Record attempted connections and files written outside the project. |
| Installation Finding | One observed connection attempt or filesystem change attributed to an Install Check. | Record its source and coverage. |
| Upgrade Check | Bumping, installing, typechecking, and testing one Upgrade. | Count a new failure only if it fails again on a rerun. |
| Check Result | The result of a check. | Passed, failed with the failing tests, or untested with the reason. |
| Test file error | A test runner error attributed to a file outside a named test case, such as a module-load or setup error. | Show **Test file errors** and record each file and reason under `testFileErrors`. Failed and skipped cases keep their own counts. |
| Code Feature Match | A new feature in an Upgrade's release notes matched to code it could replace in the Repository. | Cite the release notes and the code. Use CodeFeatureMatch in the library and “Where this fits in your code” in the report. |
| Agent Attempt | One execution of a coding agent inside the sandbox to fix a broken Upgrade or adopt a Code Feature Match. | Bound the attempt by time and cost. |
| Patch | A git format-patch file of tested commits, tied to the commit it was tested on. | Apply the upgrade patch first. The feature patch applies on top of it. |
| Verdict | The final result for one Upgrade. | Passes as is, Fixed, Fixed with test changes, Can't fix, or Untested. |
| Inspection Report | The result of the Inspection. | Include the Baseline, per-upgrade findings, Verdicts, Patches, and event timeline. |
| Inspection Event | A typed event emitted as an Inspection progresses. | Step started, step finished, detail, inspection finished, or inspection failed. |
| Sandbox Event | An Inspection Event recording an action by the sandbox's controls. | Sandbox created, network locked, connection blocked, agent started with its key kept out of the sandbox, or sandbox deleted. Highlight these events and list them above the live log and timeline. |
| Model Request Sandbox | An isolated provider runtime that sends release-summary and Code Feature Match requests through a verified stored credential. | One per Inspection on first use. It contains no Repository checkout. Its verified startup is a Sandbox Event. |
| Sandbox Provider | The interface checks use to create a sandbox, execute commands in it, and destroy it. | Runta is the shipped provider. Unit tests use a fake. |
| Ecosystem Adapter | Language support behind one interface to detect the package manager, install, bump a dependency, typecheck, test, and list upgrades. | The Node adapter covers JavaScript and TypeScript. |
| Guest | The code that runs inside the sandbox beside the Repository checkout. | The Ecosystem Adapter commands, installation observer, agent request and patch tools in `guest/`. The host controls them through the Sandbox Provider. |

## Inspection Report labels

Use **Inspection Report** in product copy. In API docs, call the model-enabled result the **version 2 Inspection Report** (`InspectionReportV2`). **Repair** and **Feature adoption** are the two Agent Attempt roles. Their API IDs are `repair` and `featureAdoption`. **Turn limit** (`maxTurns`) bounds how many turns an attempt can take.

Use **Direct replacement** or **Inferred replacement** for a Code Feature Match. Identify the **Source location**, **Affected call sites** and **Adoption outcome**. Reserve **Verdict** for the Upgrade.

The **Final patch check** produces **Patch verification**. Label the artifact **Download patch** and identify **Applies to commit**, **Tested commit** and **Required upgrade patch**. Report **Dependency changes**, **Installed size change** and **Why no tested patch is available** when recorded.

Use `usageAsOf` for the timestamp through which the Inspection Report measures runtime usage. An unconfirmed deletion can accrue additional cost after that time.

Separate **Model cost** from **Reserved upper bound** and label measured reply tokens **Output tokens**.

Use **Prompt versions** (`promptVersions`) in a saved Inspection Report. Each prompt reference identifies the effective template by name, version and SHA-256. Keep dispatched model prompts separate from generated Patch instructions.

In the daily admin view, **share rate** is the fraction of completed Inspection Reports viewed by someone other than their creator. **Viewer to runner** is the fraction of those viewers who start their own Inspection within seven days of their first qualifying view.

## Rejected terms

| Avoid | Use |
| --- | --- |
| “Safe” for an Upgrade | “Passed inspection” plus the evidence, such as which tests passed at the inspected commit. |
| “Run” outside infrastructure code | Inspection for the end-to-end check. Reserve run for infrastructure such as a process or CI job. |
| Runta in a code identifier outside its provider | Sandbox Provider or Sandbox Event, according to what the identifier represents. Customer copy may name Runta. |
| Plugin or plug-in for language support | Ecosystem Adapter. |
| Chosen version | Named version. |
| Refuse or refusal for a version or a request | Reject or rejection. |
| Hostile input | Untrusted input. |
| Pin, pinned or pinning | Declared package manager version for a package manager. Inspected commit, or resolve and keep one commit, for a Repository. Workspace versions for locked versions. List first for Sandbox Events. |
| Dependency inventory | Locked dependencies. Keep inventory for the Baseline test inventory and a Sandbox Provider's runtime inventory. |
| Accepted version | Eligible dependency version. |
| Bundled version | Bundled package manager version. |
| Unreadable project | Unreadable repository. |
| A bare `version` in an identifier that could be a dependency's or a package manager's | Name the owner: `eligibleDependencyVersions`, `bundledPackageManagerVersion`, `declaredPackageManagerVersion`. |

Keep branding in customer copy. In code, comments, and specs, name what the thing does.
