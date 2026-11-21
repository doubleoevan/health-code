import { type CheckResult, type Evidence, InspectionError, type TestFailure } from "./contracts.ts"

const reasonDetails: Readonly<Record<string, string>> = {
	"no-tsconfig": "The project has no TypeScript configuration.",
	"missing-test-script": "The project has no test script.",
	"command-timeout": "The command reached its time limit.",
	"inspection-deadline": "The inspection reached its time limit.",
	"baseline-unavailable": "The Baseline could not establish a comparison.",
	"installation-finding": "The installation attempted an unexpected connection or filesystem change.",
	"incomplete-observation": "Installation observation was incomplete.",
	"install-failed": "The upgrade could not be installed.",
	"confirmation-install-unavailable": "The confirmation install could not establish a usable checkout.",
	"confirmation-build-unavailable": "The confirmation build could not establish a comparable test environment.",
	"incomplete-test-report": "The test report is incomplete.",
	"invalid-test-report": "The test report could not be read.",
	"unidentified-test-failure": "The test command failed without identifying a failed test.",
	"opaque-baseline": "The Baseline test failure could not be attributed to a specific test.",
	"unconfirmed-failure": "The second attempt did not confirm the first failure.",
}
export function untested(reason: string, evidence: Evidence[] = []): CheckResult {
	return { status: "untested", reason, detail: reasonDetails[reason] ?? reason, evidence }
}
function toTestFailureKey(test: TestFailure): string {
	return JSON.stringify([test.workspace, test.file, test.name ?? null])
}

// compare stable diagnostic text for failures without case identities
function toFailureSignature(result: CheckResult): string {
	const evidence = result.evidence[0]
	const output = (evidence?.stderr || evidence?.stdout || "").trim()
	const diagnostics = output
		.split("\n")
		.filter((line) => /error|failed/i.test(line))
		.join("\n")

	// strip elapsed times before comparing diagnostics
	return `${String(evidence?.exitCode)}:${(diagnostics || output).replace(/\d+ms|\d+\.\d+s/g, "")}`
}
export async function confirm(
	first: CheckResult,
	baseline: CheckResult,
	retry: () => Promise<CheckResult>,
): Promise<CheckResult> {
	// propagate missing baseline evidence before comparing outcomes
	if (baseline.status === "untested") {
		return untested(baseline.reason, first.evidence)
	}
	if (first.status !== "failed") {
		return first
	}

	// exclude known baseline failures by workspace and identity
	const known = new Set(baseline.status === "failed" ? baseline.failingTests.map(toTestFailureKey) : [])
	const added = first.failingTests.filter((test) => !known.has(toTestFailureKey(test)))
	if (baseline.status === "failed" && (!first.failingTests.length || !known.size)) {
		return untested("opaque-baseline", first.evidence)
	}
	if (first.failingTests.length && !added.length) {
		return { status: "passed", evidence: first.evidence, excluded: first.failingTests }
	}

	// retry new failures before attributing them to the upgrade
	let second: CheckResult
	try {
		second = await retry()
	} catch (error) {
		if (!isDeadline(error)) {
			throw error
		}

		// retain unconfirmed failures when the retry reaches its deadline
		return {
			...untested("inspection-deadline", first.evidence),
			attempts: [toAttempt(first)],
			unconfirmedTests: added,
			excluded: first.failingTests.filter((test) => known.has(toTestFailureKey(test))),
		}
	}
	return compareAttempts({ first, second, known, added })
}
type FailedCheck = Extract<CheckResult, { status: "failed" }>
function compareAttempts({
	first,
	second,
	known,
	added,
}: {
	first: FailedCheck
	second: CheckResult
	known: Set<string>
	added: TestFailure[]
}): CheckResult {
	// combine evidence and distinguish excluded baseline failures
	const evidence = [...first.evidence, ...second.evidence]
	const attempts = [first, second].map(toAttempt)
	const excluded = first.failingTests.filter((test) => known.has(toTestFailureKey(test)))
	const observed = { attempts, excluded }

	// retain the first attempt's failures when they cannot be reproduced
	if (second.status !== "failed") {
		return {
			...untested(second.status === "untested" ? second.reason : "unconfirmed-failure", evidence),
			...observed,
			unconfirmedTests: added,
		}
	}
	const repeated = new Set(second.failingTests.map(toTestFailureKey))
	const failingTests = added.filter((test) => repeated.has(toTestFailureKey(test)))
	if (failingTests.length || repeatedOpaqueFailure(first, second)) {
		return {
			status: "failed",
			evidence,
			failingTests,
			...observed,
			unconfirmedTests: added.filter((test) => !repeated.has(toTestFailureKey(test))),
		}
	}
	return { ...untested("unconfirmed-failure", evidence), ...observed, unconfirmedTests: added }
}

function isDeadline(error: unknown): boolean {
	return error instanceof InspectionError && error.code === "deadline"
}

function repeatedOpaqueFailure(
	first: Extract<CheckResult, { status: "failed" }>,
	second: Extract<CheckResult, { status: "failed" }>,
): boolean {
	return (
		!first.failingTests.length &&
		!second.failingTests.length &&
		toFailureSignature(first) === toFailureSignature(second)
	)
}

function toAttempt(result: CheckResult): NonNullable<CheckResult["attempts"]>[number] {
	return { status: result.status, failingTests: result.status === "failed" ? result.failingTests : [] }
}
