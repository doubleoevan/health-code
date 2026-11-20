---
name: domain-model
description: Names Health Code entities when writing or reviewing types, files, events, tools, specs, prompts, and customer copy.
---

# Health Code domain model

An **Inspection** targets a **Repository** at a pinned commit. An **Ecosystem Adapter** supplies the language-specific commands, and a **Sandbox Provider** supplies the environment. The **Baseline** establishes which tests already fail. For each **Upgrade**, the **Install Check** observes installation and the **Upgrade Check** compares the changed dependency against the Baseline. Each check yields a **Check Result**. An **Agent Attempt** can repair a broken Upgrade or adopt a **Feature Match** and produce a tested **Patch**. The **Report Card** records the per-upgrade **Verdict**, evidence, patches, and timeline of **Inspection Events**, highlighting each **Sandbox Event**.

| Entity | What it is | Notes |
| --- | --- | --- |
| Repository | A public GitHub repository an Inspection targets. | Pin the commit for each Inspection. |
| Inspection | One end-to-end check of a Repository at a pinned commit. | Produces one Report Card. |
| Baseline | The install, typecheck, and tests on the Repository before any change. | Exclude tests that fail here when attributing failures to an Upgrade. |
| Upgrade | Moving one dependency from its current version to a newer one. | Identify the dependency and both versions. |
| Install Check | Installation of an Upgrade with the network locked to package registries. | Record attempted connections and files written outside the project. |
| Installation Finding | One observed connection attempt or filesystem change attributed to an Install Check. | Record its source and coverage. |
| Upgrade Check | Bumping, installing, typechecking, and testing one Upgrade. | Count a new failure only if it fails again on a rerun. |
| Check Result | The result of a check. | Passed, failed with the failing tests, or untested with the reason. |
| Feature Match | A new feature in an Upgrade's release notes matched to code it could replace in the Repository. | Cite the release notes and the code. |
| Agent Attempt | One execution of a coding agent inside the sandbox to fix a broken Upgrade or adopt a Feature Match. | Bound the attempt by time and cost. |
| Patch | A git format-patch file of tested commits, pinned to the commit it was tested on. | Apply the upgrade patch first. The feature patch applies on top of it. |
| Verdict | The final result for one Upgrade. | Passes as is, Fixed, Fixed with test changes, Can't fix, or Untested. |
| Report Card | The result of the Inspection. | Include the Baseline, per-upgrade findings, Verdicts, Patches, and event timeline. |
| Inspection Event | A typed event emitted as an Inspection progresses. | Step started, step finished, detail, inspection finished, or inspection failed. |
| Sandbox Event | An Inspection Event recording an action by the sandbox's controls. | Sandbox created, network locked, connection blocked, agent started with its key kept out of the sandbox, or sandbox deleted. Highlight and pin these events in the live log and timeline. |
| Sandbox Provider | The interface checks use to create a sandbox, execute commands in it, and destroy it. | Runta is the shipped provider. Unit tests use a fake. |
| Ecosystem Adapter | Language support behind one interface to detect the package manager, install, bump a dependency, typecheck, test, and list upgrades. | The Node adapter covers JavaScript and TypeScript. |

## Rejected terms

| Avoid | Use |
| --- | --- |
| “Safe” for an Upgrade | “Passed inspection” plus the evidence, such as which tests passed at the pinned commit. |
| “Run” outside infrastructure code | Inspection for the end-to-end check. Reserve run for infrastructure such as a process or CI job. |
| Runta in a code identifier outside its provider | Sandbox Provider or Sandbox Event, according to what the identifier represents. Customer copy may name Runta. |
| Plugin or plug-in for language support | Ecosystem Adapter. |

Keep branding in customer copy. In code, comments, and specs, name what the thing does.
