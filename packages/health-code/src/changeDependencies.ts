import { gt, valid } from "semver"
import type { z } from "zod"
import type { CodeFeatureMatch } from "./agentContracts.ts"
import { bumpManifest, type Manifest, sections, toManifestPath } from "./bumpManifest.ts"
import { formatManifest } from "./formatManifest.ts"
import type { decision } from "./proposeEdits.ts"
import {
	cleanInstall,
	type PatchEvidence,
	recordCommit,
	requireBaseline,
	type State,
	trackedLockfile,
	verifyLifecycleHooks,
	verifyManifest,
	workspace,
} from "./verifyCandidate.ts"

type DependencyRequest = { name: string; version: string; reason: string }

/**
 * Applies the dependency changes proposed for one agent turn.
 */
export async function prepareDependencies({
	state,
	evidence,
	edit,
	match,
}: {
	state: State
	evidence: PatchEvidence
	edit: z.infer<typeof decision>
	match?: CodeFeatureMatch
}): Promise<void> {
	// require at least one actionable edit
	if (!edit.edits.length && !edit.dependency && !edit.dependencies?.length && !edit.removeDependency) {
		throw new Error("Agent returned a diagnosis without edits")
	}

	// reject a dependency requested twice in one turn
	const requested = [...(edit.dependencies ?? []), ...(edit.dependency ? [edit.dependency] : [])]
	if (new Set(requested.map((entry) => entry.name)).size !== requested.length) {
		throw new Error("A dependency can be requested once per turn")
	}

	// upgrade declared dependencies as one set before adding new ones
	const declared = requested.filter((entry) => !match && isDeclared(evidence, entry.name))
	await upgradeLinkedDependencies(evidence, state, declared)
	for (const addition of requested.filter((entry) => !declared.includes(entry))) {
		await addDependency(evidence, state, addition)
	}

	// allow removal only while adopting a replacement feature
	if (edit.removeDependency) {
		if (!match || edit.removeDependency === evidence.report.dependency) {
			throw new Error("Dependency removal requires a feature adoption")
		}
		await removeDependency(evidence, state, edit.removeDependency)
	}
}

// find a direct dependency declared by any workspace
function isDeclared(evidence: PatchEvidence, name: string): boolean {
	return Object.hasOwn(evidence.adapter.project?.sources ?? {}, name)
}

// upgrade dependencies that must move together in one verified commit
async function upgradeLinkedDependencies(
	evidence: PatchEvidence,
	state: State,
	requested: DependencyRequest[],
): Promise<void> {
	const changes = requested.filter(
		(entry) => !state.dependencies.some((known) => known.name === entry.name && known.version === entry.version),
	)
	if (!changes.length) {
		return
	}

	// update every workspace that declares a requested dependency
	const sources = evidence.adapter.project?.sources ?? {}
	const manifests = new Map<string, { text: string; manifest: Manifest }>()
	await workspace(evidence, { kind: "restore", tip: state.tip })

	// bump each requested dependency in memory before editing files
	for (const change of changes) {
		requireNewerVersion(evidence, change, Object.values(sources[change.name] ?? {}))
		for (const dir of Object.keys(sources[change.name] ?? {})) {
			const file = toManifestPath(dir)
			const entry = manifests.get(file) ?? (await readManifest(evidence, file, state.tip))

			// keep one copy of a manifest that several changes share
			bumpManifest({ dir, manifest: entry.manifest, name: change.name, target: change.version })
			manifests.set(file, entry)
		}
	}

	// install the complete set so linked version requirements agree
	for (const [file, { text, manifest }] of manifests) {
		await workspace(evidence, { kind: "edit", file, contents: formatManifest(text, manifest) })
	}
	const label = changes.map((change) => `${change.name} ${change.version}`).join(", ")
	await refreshDependencies(evidence, label)
	for (const [file, { manifest }] of manifests) {
		await verifyManifest(evidence, file, manifest)
	}

	// record the set as one flagged commit
	const commit = await recordCommit(
		evidence,
		state,
		`build: upgrade ${label}`.slice(0, 180),
		[...manifests.keys(), trackedLockfile(evidence)],
		"dependency",
		changes.map((change) => change.reason).join("\n"),
	)

	// keep only the latest version of each linked dependency
	const names = new Set(changes.map((change) => change.name))
	const unchanged = state.dependencies.filter((entry) => !names.has(entry.name))
	state.dependencies = [
		...unchanged,
		...changes.map((change) => ({ ...change, from: { ...sources[change.name] }, commit })),
	]
}

// keep the committed text so edits preserve its formatting
async function readManifest(
	evidence: PatchEvidence,
	file: string,
	revision: string,
): Promise<{ text: string; manifest: Manifest }> {
	const text = await workspace(evidence, { kind: "read", file, revision })
	return { text, manifest: JSON.parse(text) }
}

// keep linked upgrades ahead of every installed version
function requireNewerVersion(evidence: PatchEvidence, change: DependencyRequest, installed: string[]): void {
	if (change.name === evidence.report.dependency) {
		throw new Error("The target dependency must stay at its upgraded version")
	}
	if (!installed.every((version) => valid(version) && gt(change.version, version))) {
		throw new Error(`${change.name} ${change.version} must be newer than its installed version`)
	}
}

// install changed manifests under the Baseline observation rules
async function refreshDependencies(evidence: PatchEvidence, label: string): Promise<void> {
	requireBaseline(evidence)
	const { adapter, baseInstall, baselinePatchVerificationInputs } = evidence

	// require a clean install that contacts only Baseline destinations
	const install = await adapter.refreshInstallation()
	if (install.check.status !== "passed" || !cleanInstall(install.observation, baseInstall)) {
		throw new Error(
			`Flagged dependency ${label} could not be installed: ${install.check.status}, ${install.observation.reason ?? (install.observation.findings.length ? "installation finding" : "destination comparison")}. ${install.check.evidence
				.map((entry) => entry.stderr.slice(-450))
				.join(" ")
				.slice(-600)}`,
		)
	}

	// reject new lifecycle scripts before recording the change
	verifyLifecycleHooks(baselinePatchVerificationInputs.lifecycleHookSignatures, await adapter.data(["lifecycle"]))
}

async function addDependency(evidence: PatchEvidence, state: State, dependency: DependencyRequest): Promise<void> {
	if (state.dependencies.some((entry) => entry.name === dependency.name && entry.version === dependency.version)) {
		return
	}

	// restore the committed candidate before modifying its manifest
	await workspace(evidence, { kind: "restore", tip: state.tip })
	const { text, manifest } = await readManifest(evidence, "package.json", state.tip)
	if (sections.some((section) => Object.hasOwn(manifest[section] ?? {}, dependency.name))) {
		throw new Error("Dependency already present outside the repair upgrade set")
	}
	manifest.dependencies = { ...manifest.dependencies, [dependency.name]: dependency.version }

	// reinstall to verify the proposed dependency addition
	await workspace(evidence, { kind: "edit", file: "package.json", contents: formatManifest(text, manifest) })
	await refreshDependencies(evidence, `${dependency.name}@${dependency.version}`)
	await verifyManifest(evidence, "package.json", manifest)
	const commit = await recordCommit(
		evidence,
		state,
		`build: add ${dependency.name} ${dependency.version}`,
		["package.json", trackedLockfile(evidence)],
		"dependency",
		dependency.reason,
	)
	state.dependencies.push({ ...dependency, commit })
}

async function removeDependency(evidence: PatchEvidence, state: State, name: string): Promise<void> {
	const file = "package.json"

	// remove dependencies from the committed manifest
	await workspace(evidence, { kind: "restore", tip: state.tip })
	const { text, manifest } = await readManifest(evidence, file, state.tip)
	const present = sections.filter((section) => Object.hasOwn(manifest[section] ?? {}, name))
	if (!present.length) {
		throw new Error("Dependency is absent from the root manifest")
	}

	// delete each declaration before refreshing the lockfile
	for (const section of present) {
		delete manifest[section]?.[name]
	}
	await workspace(evidence, { kind: "edit", file, contents: formatManifest(text, manifest) })
	await refreshDependencies(evidence, `removal of ${name}`)

	// verify and commit the manifest together with the lockfile
	await verifyManifest(evidence, file, manifest)
	const lock = trackedLockfile(evidence)
	await recordCommit(evidence, state, `build: remove ${name}`, [file, lock])
	state.removedDependency = name
}
