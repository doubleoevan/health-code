import { posix } from "node:path"
import type { z } from "zod"
import type { CodeFeatureMatch } from "../agentContracts.ts"
import { prepareDependencies } from "./prepareDependencies.ts"
import type { decision } from "./proposeEdits.ts"
import { reviewNewTest, reviewTestEdit } from "./reviewTestEdit.ts"
import { caseMatchesTitle } from "./testCaseName.ts"
import {
	cleanInstall,
	hasCase,
	type PatchEvidence,
	readPatchVerificationInputs,
	recordCommit,
	requireBaseline,
	type State,
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
	match?: CodeFeatureMatch
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
					!evidence.baselinePatchVerificationInputs?.projectFilePaths.includes(proposal.file) &&
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

	// apply source edits with the inspected test harness protected
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
	const { adapter, inspectionReport, baselinePatchVerificationInputs, report, baseInstall } = evidence

	// locate the confirmed failure in the upgrade report
	const failingCase =
		report.tests.status === "failed" &&
		report.tests.failingTests.find(
			(test) =>
				(test.workspace === "." ? test.file : test.workspace + "/" + test.file) === file &&
				caseMatchesTitle(test.name, name),
		)

	// find the release notes named by the model
	const note = evidence.releaseNotes?.find(
		(note) =>
			behaviorChange &&
			note.source === behaviorChange.source &&
			note.text.includes(behaviorChange.quote) &&
			failingCase &&
			note.workspaces.includes(failingCase.workspace),
	)
	const original = await workspace(evidence, { kind: "read", file, revision: inspectionReport.repository.commit })
	const symbol = behaviorChange?.symbol

	// require the old source and release notes to support the change
	if (
		!state.bumpTip ||
		!hasCase(baselinePatchVerificationInputs, file, name, "passed") ||
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
		if (tests.status !== "failed" || !hasCase(await readPatchVerificationInputs(adapter), file, name, "failed")) {
			throw new Error("Old and new behavior could not be demonstrated independently")
		}
	}
	try {
		// compare both revisions before restoring the candidate
		await requireFailure(state.bumpTip)
		await requireFailure(inspectionReport.repository.commit, contents)
	} finally {
		await workspace(evidence, { kind: "restore", tip: state.tip })
	}
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
async function reviewTestFile({
	evidence,
	state,
	file,
	contents,
	create,
	citation,
	mockDependency,
}: {
	evidence: PatchEvidence
	state: State
	file: string
	contents: string
	create: boolean

	// identify the cited change and the package whose mocks can move
	citation: z.infer<typeof decision>["behaviorChange"]
	mockDependency?: string
}): Promise<ReturnType<typeof reviewTestEdit>> {
	if (create) {
		return reviewNewTest(contents)
	}

	// compare the proposal with the committed test
	const before = await workspace(evidence, { kind: "read", revision: state.tip, file })
	return reviewTestEdit({ before, after: contents, citation, mockDependency })
}

// list the cases that must pass after a reviewed edit
function toReviewedNames(review: ReturnType<typeof reviewTestEdit>): string[] {
	if (review.kind === "mock") {
		return []
	}
	return review.kind === "coverage" ? review.names : [review.name]
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
	match?: CodeFeatureMatch
	evidence: PatchEvidence
	reason: string
	behaviorChange: z.infer<typeof decision>["behaviorChange"]
}): Promise<void> {
	// select test files for independent review
	const tests = [...changed].filter(([file]) => testFiles.has(file))
	const mockDependency = match ? undefined : evidence.report.dependency
	for (const [file, contents] of tests) {
		const createTest = created.has(file)
		const review = await reviewTestFile({
			evidence,
			state,
			file,
			contents,
			create: createTest,
			citation: behaviorChange,
			mockDependency,
		})
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
			review.kind === "coverage" ? undefined : "test",
			review.kind === "expectation" && behaviorChange
				? reason + "\n" + behaviorChange.source + "\n" + behaviorChange.quote
				: reason,
		)
		state.files.set(file, contents)
		state.testChanged ||= review.kind !== "coverage"
		const names = toReviewedNames(review)
		state.expectedCases.push(...names.map((name) => ({ file, name })))
	}
}
