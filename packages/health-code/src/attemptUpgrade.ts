import { randomUUID } from "node:crypto"
import { type AgentRole, agentRoleLabels, type CodeFeatureMatch } from "./agentContracts.ts"
import { applyDecision } from "./applyAgentEdits.ts"
import { buildPrompt, parseAnswer } from "./buildPrompt.ts"
import { sections } from "./bumpManifest.ts"
import { redact, rethrowInspectionFailure } from "./collectEvents.ts"
import { SandboxUnavailableError } from "./contracts.ts"
import type { ModelInspection } from "./inspectModels.ts"
import { measureFeature } from "./measureFeature.ts"
import { attemptBudget } from "./modelBudget.ts"
import { type decision, readDecision } from "./proposeEdits.ts"
import { requestAgentTurn } from "./requestAgentTurn.ts"
import {
	cleanInstall,
	type PatchEvidence,
	type PatchVerificationInputs,
	requireBaseline,
	type State,
	verifyTree,
	workspace,
} from "./verifyCandidate.ts"

export async function attemptUpgrade(
	engine: ModelInspection,
	evidence: PatchEvidence,
	state: State,
	match?: CodeFeatureMatch,
): Promise<void> {
	// choose the role and its budget from the upgrade evidence
	const { report } = evidence
	const manifest = JSON.parse(await workspace(evidence, { kind: "read", file: "package.json", revision: state.tip }))
	const declaredDependencies = Object.assign({}, ...sections.map((section) => manifest[section] ?? {}))
	const role = match ? "featureAdoption" : "repair"
	const budget = attemptBudget(role, engine.options.limits)
	evidence.context.attemptEnd = budget.end
	const files = new Set([
		...evidence.usage.usage.map((entry) => entry.file),
		...report.locators.filter((entry) => entry.url && !entry.reason).map((entry) => entry.file),
	])

	// load the allowed source set and snapshot the starting candidate
	const testFiles = discoveredTests(evidence.baselinePatchVerificationInputs)
	await loadAllowedFiles({ evidence, state, files })
	const initial = structuredClone(state)
	const initialSource = initial.files
	engine.attempt = { role, attemptId: randomUUID() }
	const publishedVersions = new Map<string, string[]>()
	let started = false
	let turn = 0

	// collect failed check details for the first prompt
	const diagnostics = [report.install, report.typecheck, report.tests]
		.flatMap((check) => check.evidence.map((item) => (item.stdout + item.stderr).slice(-4000)))
		.join("\n")
	let lastEvidence = ""
	while (budget.turns > 0 && Date.now() < budget.end) {
		turn++

		// include prior attempts and pinned source evidence in the request
		const prompt = await buildPrompt(
			role,
			{
				requestedTests: state.requestedTests,
				diagnostics,
				lastEvidence,
				attempts: state.actions.slice(-4),
				publishedVersions: Object.fromEntries(publishedVersions),
				availableTests: [...testFiles].slice(0, 200),
				declaredDependencies,
				addedDependencies: state.dependencies.map(({ name, version }) => ({ name, version })),
				dependency: report.dependency,
				target: report.to,
				summary: report.releaseSummary,
				releaseNotes: evidence.releaseNotes?.map(({ source, text }) => ({ source, text: text.slice(0, 1600) })),
				match,
				files: Object.fromEntries([...state.files].filter(([file]) => !testFiles.has(file))),
			},
			evidence.context.prompts,
		)

		// request the next bounded model turn
		const answer = await requestAgentTurn({ engine, evidence, role, prompt, started, budget })
		started = true
		let proposedEdit = false
		try {
			const edit = readDecision(parseAnswer(answer))

			// handle read-only evidence requests before applying edits
			const lookup = await readRequestedEvidence({ edit, evidence, state, testFiles, publishedVersions, initial })
			if (lookup !== undefined) {
				lastEvidence = lookup
				continue
			}
			delete state.requestedTests
			proposedEdit = true

			// apply the proposed change before checking the committed tree
			await applyDecision({ evidence, state, match, edit, testFiles })

			await workspace(evidence, { kind: "restore", tip: state.tip })
			await verifyTree(evidence, state)

			// measure an adoption against the original source
			if (match) {
				recordBenefit({ match, evidence, state, initialSource, testFiles })
			}
			return
		} catch (error) {
			// preserve terminal inspection errors across rejected turns
			rethrowInspectionFailure(error, evidence.context)
			if (error instanceof SandboxUnavailableError) {
				throw error
			}

			// Retry only agent decisions the current sandbox can still verify.
			lastEvidence = await reportRejectedTurn({ evidence, state, role, turn, error, proposedEdit })
		}
	}
	throw new Error("No verified repair within the attempt limits")
}

function discoveredTests(verificationInputs?: PatchVerificationInputs): Set<string> {
	return new Set(verificationInputs?.discoveredTestFiles ?? verificationInputs?.cases.map((entry) => entry[0]))
}
async function reportRejectedTurn({
	evidence,
	role,
	turn,
	state,
	error,
	proposedEdit,
}: {
	evidence: PatchEvidence
	role: AgentRole
	turn: number
	state: State
	error: unknown
	proposedEdit: boolean
}): Promise<string> {
	// bound the diagnostic returned to the next model turn
	const lastEvidence = (error instanceof Error ? error.message : "Invalid edit").slice(0, 4000)
	state.actions.push(lastEvidence)
	const step = evidence.context.timeline.findLast(
		(event) => event.type === "step.started" && event.label === agentRoleLabels[role],
	)
	if (step?.type === "step.started") {
		await evidence.context.emit({
			type: "detail",
			stepId: step.stepId,
			stream: "stderr",
			text: `Agent turn ${turn}: ${lastEvidence.slice(0, 400)}`,
			truncated: lastEvidence.length > 400,
		})
	}
	if (lastEvidence === "Agent returned a diagnosis without edits") {
		throw error
	}
	return proposedEdit ? lastEvidence + (await collectDiagnostics(evidence, state)) : lastEvidence
}
async function readRequestedEvidence({
	edit,
	evidence,
	state,
	testFiles,
	publishedVersions,
	initial,
}: {
	edit: ReturnType<typeof decision.parse>
	evidence: PatchEvidence
	state: State
	initial: State

	// retain discovered tests and registry lookups for this attempt
	testFiles: Set<string>
	publishedVersions: Map<string, string[]>
}): Promise<string | undefined> {
	// restore the original candidate when the model requests a restart
	if (edit.restart) {
		await workspace(evidence, { kind: "restore", tip: initial.tip })
		delete state.requestedTests
		delete state.removedDependency
		Object.assign(state, structuredClone(initial), { actions: state.actions })
		state.actions.push(edit.reason)
		return "Restored the starting candidate. The attempt’s time, cost and turn limits still apply."
	}

	// restrict requested test reads to the baseline inventory
	if (edit.readTests) {
		if (!edit.readTests.every((file) => testFiles.has(file))) {
			throw new Error("Read requires a discovered Baseline test path")
		}
		await loadAllowedFiles({ evidence, state, files: new Set(edit.readTests) })
		state.requestedTests = Object.fromEntries(
			edit.readTests.map((file) => {
				// record availability for each requested test source
				const source = state.files.get(file)
				if (source === undefined) {
					return [file, "Test source unavailable"]
				}
				const bytes = Buffer.from(source)
				return [
					file,
					bytes.length <= 12000
						? source
						: bytes.subarray(0, 12000).toString("utf8") + "\n[Remaining test source omitted at 12,000 bytes]",
				]
			}),
		)
		return "The requestedTests field gives the requested source or its availability limit."
	}

	// reuse version lookups made earlier in the attempt
	if (edit.lookup) {
		state.actions.push(edit.reason)
		const names = edit.lookup.filter((name) => !publishedVersions.has(name))
		const versions = await evidence.adapter.registry(names)

		// cache only names present in the registry response
		for (const name of names) {
			const list = versions[name]
			if (list) {
				publishedVersions.set(name, list.slice(-24))
			}
		}

		// give the next turn access to the verified registry versions
		return "Published versions are listed under publishedVersions. Choose an exact version before proposing dependency and source changes."
	}
}

async function loadAllowedFiles({
	evidence,
	state,
	files,
}: {
	evidence: PatchEvidence
	state: State
	files: Set<string>
}): Promise<void> {
	// restrict model-visible files to the baseline inventory
	for (const file of files) {
		if (!evidence.baselinePatchVerificationInputs?.projectFilePaths.includes(file)) {
			continue
		}
		const text = await workspace(evidence, { kind: "read", file, revision: state.tip }).catch(() => undefined)

		// retain source only when redaction leaves the bytes intact
		if (text !== undefined && redact(text) === text) {
			state.files.set(file, text)
		}
	}
}
async function collectDiagnostics(evidence: PatchEvidence, state: State): Promise<string> {
	const { adapter } = evidence

	// restore the committed candidate before collecting diagnostics
	await workspace(evidence, { kind: "restore", tip: state.tip })
	for (const file of state.files.keys()) {
		state.files.set(file, await workspace(evidence, { kind: "read", file }))
	}
	requireBaseline(evidence)
	const checks = await adapter.install()

	// require comparable install observations for diagnostic checks
	if (!adapter.lastObservation || !cleanInstall(adapter.lastObservation, evidence.baseInstall)) {
		throw new Error("Diagnostic installation observation failed")
	}
	if (checks.status === "passed") {
		const check = await adapter.typecheck()
		const tests = await adapter.test()

		// return bounded typecheck and test details
		return (
			"\n" +
			[check, tests]
				.flatMap((result) => result.evidence.map((item) => `${item.stdout}\n${item.stderr}`.slice(-2500)))
				.join("\n")
		)
	}

	// omit check diagnostics when installation fails
	return ""
}

// record the adoption benefit against its original evidence
function recordBenefit({
	match,
	evidence,
	state,
	initialSource,
	testFiles,
}: {
	match: CodeFeatureMatch
	evidence: PatchEvidence
	state: State
	initialSource: Map<string, string>
	testFiles: Set<string>
}): void {
	// locate the affected symbol before measuring the replacement
	const symbol =
		match.kind === "deprecated"
			? evidence.usage.usage.find((entry) => entry.file === match.location.file && entry.line === match.location.line)
					?.symbol
			: undefined
	match.benefit = measureFeature({
		before: initialSource,
		after: state.files,
		tests: testFiles,
		symbol,
		removedDependency: state.removedDependency,
	})
}
