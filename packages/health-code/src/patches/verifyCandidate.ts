import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { Patch, PatchOperation, PatchVerification, UpgradeReportV2 } from "../agentContracts.ts"
import type { NodeAdapter } from "../checks/checkProject.ts"
import { excludeBaselineFailures } from "../checks/confirmCheck.ts"
import type { UsageEvidence } from "../checks/readUpgradeEvidence.ts"
import { bounded, type InspectionContext } from "../collectEvents.ts"
import { InspectionError, type InspectionReport, type Observation, type Sandbox } from "../contracts.ts"
import { lockfiles } from "../upgrades/readLockedDependencies.ts"
import type { ReleaseNote } from "../upgrades/readReleases.ts"
import { caseMatchesTitle } from "./testCaseName.ts"

// Decode the sandbox command's existing wire format at the provider boundary.
const patchVerificationInputsPage = z
	.object({
		files: z.array(z.string()),
		hooks: z.array(z.string()),
		discoveredFiles: z.array(z.string()).optional(),
		cases: z.array(z.tuple([z.string(), z.string(), z.enum(["passed", "failed", "skipped", "todo"])])),
		testFileErrors: z.array(z.string()),
		nextMetadataOffset: z.number().int().nonnegative().optional(),
	})
	.transform((page) => ({
		projectFilePaths: page.files,
		lifecycleHookSignatures: page.hooks,
		...(page.discoveredFiles && { discoveredTestFiles: page.discoveredFiles }),
		cases: page.cases,
		testFileErrors: page.testFileErrors,
		nextFileAndHookEntryOffset: page.nextMetadataOffset,
	}))

export type PatchVerificationInputs = Omit<z.infer<typeof patchVerificationInputsPage>, "nextFileAndHookEntryOffset">
type CaseStatus = PatchVerificationInputs["cases"][number][2]

export type PatchEvidence = {
	context: InspectionContext
	adapter: NodeAdapter
	sandbox: Sandbox
	inspectionReport: InspectionReport
	report: UpgradeReportV2

	// retain release and baseline observations for independent verification
	usage: UsageEvidence
	releaseNotes?: ReleaseNote[]
	baselinePatchVerificationInputs?: PatchVerificationInputs
	baseInstall?: Observation
	baseTests?: Observation
}

export type State = {
	base: string
	bumpTip?: string
	unresolvedBump?: boolean
	tip: string
	commits: Patch["commits"]

	// track dependency changes and source edits with their test obligations
	dependencies: UpgradeReportV2["newDependencies"]
	files: Map<string, string>
	actions: string[]
	requestedTests?: Record<string, string>
	removedDependency?: string
	expectedCases: { file: string; name: string }[]
	testChanged: boolean
}

export async function readPatchVerificationInputs(
	adapter: Pick<NodeAdapter, "data">,
): Promise<PatchVerificationInputs> {
	const { nextFileAndHookEntryOffset, ...first } = patchVerificationInputsPage.parse(
		await adapter.data(["integrity", "0"]),
	)
	const result = { ...first, cases: [...first.cases] }

	// Reassemble repository-wide paths separately from the case cursor.
	let fileAndHookEntryOffset = nextFileAndHookEntryOffset
	while (fileAndHookEntryOffset !== undefined) {
		const page = patchVerificationInputsPage.parse(
			await adapter.data(["integrity", "0", String(fileAndHookEntryOffset)]),
		)
		if (
			fileAndHookEntryOffset > 250000 ||
			(page.nextFileAndHookEntryOffset !== undefined && page.nextFileAndHookEntryOffset <= fileAndHookEntryOffset)
		) {
			throw new Error("Invalid file and hook entry offset")
		}

		// Keep the full protected inventory while transporting bounded pages.
		result.projectFilePaths = result.projectFilePaths.concat(page.projectFilePaths)
		result.lifecycleHookSignatures = result.lifecycleHookSignatures.concat(page.lifecycleHookSignatures)
		result.testFileErrors = result.testFileErrors.concat(page.testFileErrors)
		if (page.discoveredTestFiles) {
			result.discoveredTestFiles = (result.discoveredTestFiles ?? []).concat(page.discoveredTestFiles)
		}
		fileAndHookEntryOffset = page.nextFileAndHookEntryOffset
	}

	// page through protected test evidence with a fixed case ceiling
	for (let testCaseOffset = first.cases.length; testCaseOffset && testCaseOffset % 100 === 0; testCaseOffset += 100) {
		if (testCaseOffset > 100000) {
			throw new Error("Test case limit reached")
		}
		const page = patchVerificationInputsPage.parse(await adapter.data(["integrity", String(testCaseOffset)]))
		result.cases.push(...page.cases)

		// stop once the final partial page is consumed
		if (page.cases.length < 100) {
			break
		}
	}
	return result
}

export async function workspace(evidence: PatchEvidence, request: PatchOperation): Promise<string> {
	const { context, sandbox } = evidence
	const provider = context.options.sandboxProvider
	if (!provider.patchWorkspace) {
		throw new InspectionError("patch-workspace", "Provider lacks a protected patch workspace")
	}

	// run the protected operation within the remaining inspection deadline
	const operation = context.operation("setup")
	const patchWorkspace = provider.patchWorkspace
	return (await bounded((signal) => patchWorkspace(sandbox, request, { ...operation, signal }), operation)) ?? ""
}

export function requireBaseline(evidence: PatchEvidence): asserts evidence is PatchEvidence & {
	baseInstall: Observation
	baseTests: Observation
	baselinePatchVerificationInputs: PatchVerificationInputs
} {
	// require a passing baseline case for meaningful comparison
	if (!evidence.baselinePatchVerificationInputs) {
		throw new Error("Health Code could not read the original test inventory to verify a patch")
	}
	if (!evidence.baselinePatchVerificationInputs.cases.some((entry) => entry[2] === "passed")) {
		throw new Error("Baseline has no comparable passing test cases")
	}
	for (const [name, observation] of [
		["installation", evidence.baseInstall],
		["tests", evidence.baseTests],
	] as const) {
		if (!observation?.complete || !observation.destinations) {
			throw new Error(`Incomplete Baseline ${name} observation: ${observation?.reason ?? "destinations unavailable"}`)
		}
	}
}

export async function recordCommit(
	evidence: PatchEvidence,
	state: State,
	subject: string,
	files: string[],
	flag?: "dependency" | "test",
	reason?: string,
): Promise<string> {
	const tip = await workspace(evidence, { kind: "commit", parent: state.tip, subject, files })
	if (!/^[\da-f]{40}$/.test(tip)) {
		throw new Error("Invalid commit identity")
	}

	// record the verified commit and advance the candidate tip
	state.tip = tip
	state.commits.push({ sha: tip, subject, flag, reason })
	return tip
}

export function trackedLockfile(evidence: PatchEvidence): string {
	const manager = evidence.adapter.project?.manager
	const lock =
		manager &&
		lockfiles[manager].find((file) => evidence.baselinePatchVerificationInputs?.projectFilePaths.includes(file))

	// Require the lockfile that was present in the original checkout.
	if (!lock) {
		throw new Error("Missing tracked lockfile")
	}
	return lock
}

export function cleanInstall(current: Observation, baseline: Observation): boolean {
	return (
		current.complete &&
		current.findings.length === 0 &&
		// require all observed destinations to appear in baseline evidence
		!!current.destinations &&
		!!baseline.destinations &&
		current.destinations.every((host) => baseline.destinations?.includes(host))
	)
}

export async function verifyTree(evidence: PatchEvidence, state: State): Promise<PatchVerification> {
	requireBaseline(evidence)
	const { adapter, baselinePatchVerificationInputs, baseInstall, baseTests, inspectionReport } = evidence

	// reinstall the candidate and compare its network and file observations
	const install = await adapter.install()
	reportNewDestinations("install", adapter.lastObservation, baseInstall)
	if (install.status !== "passed" || !adapter.lastObservation || !cleanInstall(adapter.lastObservation, baseInstall)) {
		throw new Error(toEvidenceError("Final installation evidence failed", adapter.lastObservation))
	}
	const installation = adapter.lastObservation

	// require a final typecheck without new errors when the project provides one
	const typecheck = excludeBaselineFailures(await adapter.typecheck(), inspectionReport.baseline.typecheck)
	if (adapter.project?.typecheck !== "none" && typecheck.status !== "passed") {
		throw new Error("Final typecheck failed")
	}
	const tests = await adapter.test()
	reportNewDestinations("tests", adapter.lastObservation, baseTests)

	// require complete attributable network evidence for the final tests
	if (
		tests.status === "untested" ||
		!adapter.lastObservation?.complete ||
		!adapter.lastObservation.destinations?.every((host) => baseTests?.destinations?.includes(host))
	) {
		throw new Error(toEvidenceError("Final test evidence incomplete", adapter.lastObservation))
	}

	// verify that repository commands preserved the committed tree
	if ((await workspace(evidence, { kind: "verify", tip: state.tip })) !== state.tip) {
		throw new Error("Checks changed the tracked candidate tree")
	}
	const final = await readPatchVerificationInputs(adapter)

	// reject a failed test process with no failing case or file
	if (
		tests.status === "failed" &&
		!final.testFileErrors.length &&
		!final.cases.some((entry) => entry[2] === "failed")
	) {
		throw new Error("Test process failed without an attributable case or file")
	}

	// compare lifecycle hooks and cases with the Baseline
	verifyLifecycleHooks(baselinePatchVerificationInputs.lifecycleHookSignatures, final.lifecycleHookSignatures)
	verifyCases(baselinePatchVerificationInputs, final)
	for (const { file, name } of state.expectedCases) {
		if (!hasCase(final, file, name, "passed")) {
			throw new Error("Edited test case did not pass")
		}
	}

	// report newly discovered cases alongside the final check evidence
	const prior = new Set(baselinePatchVerificationInputs.cases.map(([file, name]) => JSON.stringify([file, name])))
	const addedCases = final.cases
		.filter(([file, name]) => !prior.has(JSON.stringify([file, name])))
		.map(([file, name]) => ({ file, name }))
	return { install, typecheck, tests, installation, testNetwork: adapter.lastObservation, addedCases }
}

function toEvidenceError(message: string, observation: Observation | undefined): string {
	return [message, observation?.reason].filter(Boolean).join(": ")
}

function reportNewDestinations(phase: string, current: Observation | undefined, baseline: Observation): void {
	const hosts = current?.destinations?.filter((host) => !baseline.destinations?.includes(host))
	if (hosts?.length) {
		throw new Error(`Final ${phase} contacted new destinations: ${[...new Set(hosts)].sort().join(", ")}`)
	}
}

export function verifyLifecycleHooks(baseline: string[], current: unknown): void {
	const known = new Set(baseline)
	const changed = z
		.array(z.string())
		.parse(current)
		.filter((hook) => !known.has(hook))

	// identify the packages and events behind newly introduced hooks
	if (changed.length) {
		const names = changed.slice(0, 8).map((hook) => {
			try {
				const [name, event] = z.tuple([z.string(), z.string(), z.string()]).rest(z.string()).parse(JSON.parse(hook))
				return `${name} (${event})`
			} catch {
				// fall back to an anonymous label for unreadable hook identities
				return "unidentified hook"
			}
		})
		throw new Error(`New lifecycle script: ${names.join(", ")}`)
	}
}

// preserve discovered baseline test files
export function verifyCases(
	baselinePatchVerificationInputs: PatchVerificationInputs,
	final: PatchVerificationInputs,
): void {
	if (baselinePatchVerificationInputs.discoveredTestFiles?.some((file) => !final.discoveredTestFiles?.includes(file))) {
		throw new Error("A Baseline test file disappeared from discovery")
	}
	const original = groupCases(baselinePatchVerificationInputs.cases)
	const current = groupCases(final.cases)

	// check every final group for new or ambiguous failures
	for (const [key, statuses] of current) {
		verifyFinalGroup(original.get(key), statuses)
	}
	for (const [key, statuses] of original) {
		const observed = current.get(key)

		// preserve the original invocations and passing outcomes
		if (
			observed?.length !== statuses.length ||
			(statuses.includes("passed") && !observed.every(passed)) ||
			(statuses.includes("failed") && !observed.includes("passed") && !observed.includes("failed"))
		) {
			throw new Error("Baseline test omitted or weakened")
		}
	}

	// require the same set of file loading errors
	if (!isDeepStrictEqual(final.testFileErrors, baselinePatchVerificationInputs.testFileErrors)) {
		throw new Error("Changed test file errors")
	}
}

function verifyFinalGroup(prior: CaseStatus[] | undefined, statuses: CaseStatus[]): void {
	if (statuses.length > 1 && (prior?.length !== statuses.length || !prior.every(passed) || !statuses.every(passed))) {
		throw new Error("Repeated test case identities are ambiguous")
	}
	if (statuses.includes("failed") && !prior?.includes("failed")) {
		throw new Error("New failures in final test inventory")
	}
}

function groupCases(cases: PatchVerificationInputs["cases"]): Map<string, CaseStatus[]> {
	const groups = new Map<string, CaseStatus[]>()
	for (const [file, name, status] of cases) {
		// group repeated case identities by file and test name
		const key = JSON.stringify([file, name])
		const group = groups.get(key)
		if (group) {
			group.push(status)
		} else {
			groups.set(key, [status])
		}
	}

	// return all observed statuses for each identity
	return groups
}

function passed(status: CaseStatus): boolean {
	return status === "passed"
}

export async function verifyManifest(evidence: PatchEvidence, file: string, expected: unknown): Promise<void> {
	const after = JSON.parse(await workspace(evidence, { kind: "read", file }))
	if (!isDeepStrictEqual(after, expected)) {
		throw new Error("Install changed undeclared manifest fields")
	}
}

export function hasCase(
	verificationInputs: PatchVerificationInputs,
	file: string,
	name: string,
	status: string,
): boolean {
	const matches = verificationInputs.cases.filter((entry) => entry[0] === file && caseMatchesTitle(entry[1], name))
	return matches.length === 1 && matches[0]?.[2] === status
}
