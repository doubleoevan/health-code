import { posix } from "node:path"
import type { z } from "zod"
import type { FeatureMatch } from "./agentContracts.ts"
import { sections } from "./bumpManifest.ts"
import type { decision } from "./proposeEdits.ts"
import { reviewNewTest, reviewTestEdit } from "./reviewTestEdit.ts"
import { caseMatchesTitle } from "./testCaseName.ts"
import {
	cleanInstall,
	hasCase,
	type PatchEvidence,
	readIntegrity,
	recordCommit,
	requireBaseline,
	type State,
	trackedLockfile,
	verifyLifecycleHooks,
	verifyManifest,
	workspace,
} from "./verifyCandidate.ts"

export async function applyDecision({
	evidence,
	state,
	match,
	edit,
	testFiles,
}: {
	evidence: PatchEvidence
	state: State
	match?: FeatureMatch
	edit: z.infer<typeof decision>
	testFiles: Set<string>
}): Promise<void> {
	state.actions.push(edit.reason)
	// prepare dependency changes before evaluating file edits
	await prepareDependencies({ state, evidence, edit, match })
	const created = new Set(
		edit.edits
			.filter(
				(proposal) =>
					"contents" in proposal &&
					!state.files.has(proposal.file) &&
					// require new test files to sit beside discovered tests
					!evidence.baselineIntegrity?.files.includes(proposal.file) &&
					adjacentTest(proposal.file, testFiles),
			)
			.map((proposal) => proposal.file),
	)
	// separate source changes from proposed test changes
	const permittedTests = new Set([...testFiles, ...state.expectedCases.map((entry) => entry.file), ...created])
	const changed = prepareEdits(edit, state, created)
	const sources = [...changed].filter(([file]) => !permittedTests.has(file))
	if (
		sources.some(([file]) =>
			/(?:^|\/)(?:__tests__|__fixtures__|__snapshots__|test|tests|fixtures|snapshots)\/|\.(?:spec|test)\.[^.]+$/i.test(
				file,
			),
		)
	) {
		throw new Error("Edits to test support files require independently comparable assertions")
	}
	// apply source edits with the pinned test harness protected
	for (const [file, contents] of sources) {
		await workspace(evidence, { kind: "edit", file, contents, protectTests: [...testFiles] })
	}
	if (sources.length) {
		await recordCommit(
			evidence,
			state,
			(match ? "feat: " : "fix: ") + edit.reason.replace(/[\r\n]/g, " ").slice(0, 180),
			sources.map(([file]) => file),
		)
	}
	// update in-memory source after committing the changes
	for (const [file, contents] of sources) {
		state.files.set(file, contents)
	}
	await reviewTests({
		changed,
		created,
		testFiles: permittedTests,
		state,
		match,
		evidence,
		reason: edit.reason,
		behaviorChange: edit.behaviorChange,
	})
}

async function addDependency(
	evidence: PatchEvidence,
	state: State,
	dep: { name: string; version: string; reason: string },
): Promise<void> {
	const { adapter, baseInstall } = evidence
	if (state.dependencies.some((entry) => entry.name === dep.name && entry.version === dep.version)) {
		return
	}
	// restore the committed candidate before modifying its manifest
	await workspace(evidence, { kind: "restore", tip: state.tip })
	const manifest = JSON.parse(await workspace(evidence, { kind: "read", file: "package.json", revision: state.tip }))
	if (sections.some((section) => Object.hasOwn(manifest[section] ?? {}, dep.name))) {
		throw new Error("Dependency already present")
	}
	manifest.dependencies = { ...manifest.dependencies, [dep.name]: dep.version }
	// reinstall to verify the proposed dependency addition
	await workspace(evidence, { kind: "edit", file: "package.json", contents: `${JSON.stringify(manifest, null, 2)}\n` })
	const install = await adapter.refreshInstallation()
	if (install.check.status !== "passed" || !baseInstall || !cleanInstall(install.observation, baseInstall)) {
		throw new Error(
			`Flagged dependency ${dep.name}@${dep.version} could not be installed: ${install.check.status}, ${install.observation.reason ?? (install.observation.findings.length ? "installation finding" : "destination comparison")}. ${install.check.evidence
				.map((entry) => entry.stderr.slice(-450))
				.join(" ")
				.slice(-600)}`,
		)
	}
	// check lifecycle changes before recording the dependency commit
	requireBaseline(evidence)
	verifyLifecycleHooks(evidence.baselineIntegrity.hooks, await adapter.data(["lifecycle"]))
	const lock = trackedLockfile(evidence)
	await verifyManifest(evidence, "package.json", manifest)
	const commit = await recordCommit(
		evidence,
		state,
		`build: add ${dep.name} ${dep.version}`,
		["package.json", lock],
		"dependency",
		dep.reason,
	)
	state.dependencies.push({ ...dep, commit })
}

async function proveBehavior({
	evidence,
	state,
	file,
	contents,
	name,
	behaviorChange,
}: {
	evidence: PatchEvidence
	state: State
	file: string
	contents: string
	// identify the assertion and the cited behavior change
	name: string
	behaviorChange: z.infer<typeof decision>["behaviorChange"]
}): Promise<void> {
	requireBaseline(evidence)
	const { adapter, card, baselineIntegrity, report, baseInstall } = evidence
	// locate the confirmed failure in the upgrade report
	const failingCase =
		report.tests.status === "failed" &&
		report.tests.failingTests.find(
			(test) =>
				(test.workspace === "." ? test.file : test.workspace + "/" + test.file) === file &&
				caseMatchesTitle(test.name, name),
		)
	// find the release evidence named by the model
	const note = evidence.releaseNotes?.find(
		(note) =>
			behaviorChange &&
			note.source === behaviorChange.source &&
			note.text.includes(behaviorChange.quote) &&
			failingCase &&
			note.workspaces.includes(failingCase.workspace),
	)
	const original = await workspace(evidence, { kind: "read", file, revision: card.repository.commit })
	const symbol = behaviorChange?.symbol
	// require the old source and release evidence to support the change
	if (
		!state.bumpTip ||
		!hasCase(baselineIntegrity, file, name, "passed") ||
		!note ||
		!symbol ||
		!behaviorChange?.quote.split(/[^\w$]+/).includes(symbol) ||
		// check that the changed behavior references the cited symbol
		!original.split(/[^\w$]+/).includes(symbol)
	) {
		throw new Error("Existing assertion lacks confirmed failure and cited release behavior")
	}
	// test each version with its opposing expectation
	async function requireFailure(tip: string, replacement?: string): Promise<void> {
		await workspace(evidence, { kind: "restore", tip })
		if (replacement !== undefined) {
			await workspace(evidence, { kind: "edit", file, contents: replacement })
		}
		// require an observed install before comparing behavior
		const install = await adapter.install()
		if (
			install.status !== "passed" ||
			!adapter.lastObservation ||
			!cleanInstall(adapter.lastObservation, baseInstall)
		) {
			throw new Error("Behavior comparison installation failed")
		}
		// require a failing result for the targeted assertion
		const tests = await adapter.test()
		if (tests.status !== "failed" || !hasCase(await readIntegrity(adapter), file, name, "failed")) {
			throw new Error("Old and new behavior could not be demonstrated independently")
		}
	}
	try {
		// compare both revisions before restoring the candidate
		await requireFailure(state.bumpTip)
		await requireFailure(card.repository.commit, contents)
	} finally {
		await workspace(evidence, { kind: "restore", tip: state.tip })
	}
}

async function removeDependency(evidence: PatchEvidence, state: State, name: string): Promise<void> {
	const file = "package.json"
	// remove dependencies from the committed manifest
	await workspace(evidence, { kind: "restore", tip: state.tip })
	const manifest = JSON.parse(await workspace(evidence, { kind: "read", file, revision: state.tip }))
	const present = sections.filter((section) => Object.hasOwn(manifest[section] ?? {}, name))
	if (!present.length) {
		throw new Error("Dependency is absent from the root manifest")
	}
	// delete each declaration before refreshing the lockfile
	for (const section of present) {
		delete manifest[section][name]
	}
	await workspace(evidence, { kind: "edit", file, contents: `${JSON.stringify(manifest, null, 2)}\n` })
	const result = await evidence.adapter.refreshInstallation()
	if (
		result.check.status !== "passed" ||
		// require the removal to keep install observations within the baseline
		!evidence.baseInstall ||
		!cleanInstall(result.observation, evidence.baseInstall)
	) {
		throw new Error("Dependency removal install failed")
	}
	// verify and commit the manifest together with the lockfile
	await verifyManifest(evidence, file, manifest)
	const lock = trackedLockfile(evidence)
	await recordCommit(evidence, state, `build: remove ${name}`, [file, lock])
	state.removedDependency = name
}
// permit new test files beside a discovered test
function adjacentTest(file: string, tests: Set<string>): boolean {
	const suffix = file.match(/\.(?:test|spec)\.[cm]?[jt]sx?$/)?.[0]
	return !!suffix && [...tests].some((known) => posix.dirname(file) === posix.dirname(known) && known.endsWith(suffix))
}
function prepareEdits(edit: z.infer<typeof decision>, state: State, created: Set<string>): Map<string, string> {
	const changed = new Map<string, string>()
	// resolve each edit against the latest proposed contents
	for (const proposed of edit.edits) {
		const original =
			changed.get(proposed.file) ?? state.files.get(proposed.file) ?? (created.has(proposed.file) ? "" : undefined)
		if (
			original === undefined ||
			!/\.[cm]?[jt]sx?$/.test(proposed.file) ||
			// reject files outside the permitted set
			/(?:^|\/)(?:.*config|setupTests)\.[^.]+$/i.test(proposed.file)
		) {
			throw new Error("Edit outside permitted source")
		}
		// distinguish whole-file additions from contextual replacements
		if ("contents" in proposed) {
			changed.set(proposed.file, proposed.contents)
			continue
		}
		if (original.split(proposed.search).length !== 2) {
			// reject ambiguous or missing edit context
			throw new Error(`Edit context in ${proposed.file} must occur exactly once`)
		}
		changed.set(
			proposed.file,
			original.replace(proposed.search, () => proposed.replacement),
		)
	}
	return changed
}
async function reviewTestFile(
	evidence: PatchEvidence,
	state: State,
	file: string,
	contents: string,
	create: boolean,
	citation: z.infer<typeof decision>["behaviorChange"],
): Promise<ReturnType<typeof reviewTestEdit>> {
	if (create) {
		return reviewNewTest(contents)
	}
	return reviewTestEdit(await workspace(evidence, { kind: "read", revision: state.tip, file }), contents, citation)
}
async function reviewTests({
	created,
	changed,
	testFiles,
	state,
	match,
	evidence,
	reason,
	behaviorChange,
}: {
	created: Set<string>
	changed: Map<string, string>
	testFiles: Set<string>
	state: State
	// bind test changes to their upgrade evidence
	match?: FeatureMatch
	evidence: PatchEvidence
	reason: string
	behaviorChange: z.infer<typeof decision>["behaviorChange"]
}): Promise<void> {
	// select test files for independent review
	const tests = [...changed].filter(([file]) => testFiles.has(file))
	for (const [file, contents] of tests) {
		const createTest = created.has(file)
		const review = await reviewTestFile(evidence, state, file, contents, createTest, behaviorChange)
		if (review.kind === "expectation") {
			// limit changed expectations to a single verified repair
			if (match || state.testChanged) {
				throw new Error("Existing assertion requires an independent upgrade check")
			}
			await proveBehavior({ evidence, state, file, contents, name: review.name, behaviorChange })
		}
		// commit the reviewed test change separately from source edits
		await workspace(evidence, { kind: "edit", file, contents, createTest })
		await recordCommit(
			evidence,
			state,
			`test: ${reason.replace(/[\r\n]/g, " ").slice(0, 180)}`,
			[file],
			review.kind === "expectation" ? "test" : undefined,
			review.kind === "expectation" && behaviorChange
				? reason + "\n" + behaviorChange.source + "\n" + behaviorChange.quote
				: reason,
		)
		state.files.set(file, contents)
		state.testChanged ||= review.kind === "expectation"
		const names = "names" in review ? review.names : [review.name]
		state.expectedCases.push(...names.map((name) => ({ file, name })))
	}
}
async function prepareDependencies({
	state,
	evidence,
	edit,
	match,
}: {
	state: State
	evidence: PatchEvidence
	edit: z.infer<typeof decision>
	match?: FeatureMatch
}): Promise<void> {
	// require at least one actionable edit
	if (!edit.edits.length && !edit.dependency && !edit.dependencies?.length && !edit.removeDependency) {
		throw new Error("Agent returned a diagnosis without edits")
	}

	for (const addition of [...(edit.dependencies ?? []), ...(edit.dependency ? [edit.dependency] : [])]) {
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
