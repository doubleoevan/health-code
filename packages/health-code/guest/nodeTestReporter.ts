import { relative } from "node:path"

type ReportedTest = {
	name: string
	nesting: number
	file?: string
	skip?: string | boolean
	todo?: string | boolean

	// the outcome and kind of the reported test
	details?: { type?: string; error?: { failureType?: string; cause?: unknown; message?: string } }
}

// the reported cases of one test file
type Assertion = { status: string; fullName: string; title: string; ancestorTitles: string[] }
type Suite = { name: string; status: string; message: string; assertionResults: Assertion[] }

// the events and results this reporter reads and writes
type ReporterEvent = { type: string; data: unknown }

/**
 * Reports Node's test results in the JSON shape Jest and Vitest use.
 */
export default async function* reportNodeTests(source: AsyncIterable<ReporterEvent>): AsyncGenerator<string> {
	const suites = new Map<string, Suite>()
	const ancestors: string[] = []
	for await (const { type, data } of source) {
		// keep the names of the tests that enclose the current one
		const test = data as ReportedTest
		if (type === "test:start") {
			ancestors.length = test.nesting
			ancestors.push(test.name)
		} else if (type === "test:pass" || type === "test:fail") {
			recordTest({ suites, test, isFailed: type === "test:fail", ancestorTitles: ancestors.slice(0, test.nesting) })
		}
	}

	// count the recorded cases by status
	const testResults = [...suites.values()]
	const statuses = testResults.flatMap((suite) => suite.assertionResults.map(({ status }) => status))
	yield JSON.stringify({
		numTotalTests: statuses.length,
		numPassedTests: statuses.filter((status) => status === "passed").length,
		numFailedTests: statuses.filter((status) => status === "failed").length,
		testResults,
	})
}

function recordTest({
	suites,
	test,
	isFailed,
	ancestorTitles,
}: {
	suites: Map<string, Suite>
	test: ReportedTest
	isFailed: boolean
	ancestorTitles: string[]
}): void {
	// group results by file and leave unattributed ones under no name
	const file = test.file ?? ""
	const suite = suites.get(file) ?? { name: file, status: "passed", message: "", assertionResults: [] }
	suites.set(file, suite)
	const error = test.details?.error
	if (isFailed && toStatus(test, isFailed) === "failed") {
		suite.status = "failed"
	}

	// Node names the whole file when it fails outside a test
	if (test.nesting === 0 && [file, relative(process.cwd(), file)].includes(test.name)) {
		if (isFailed) {
			suite.message = String(error?.cause instanceof Error ? error.cause.message : (error?.message ?? ""))
		}
		return
	}

	// describe blocks count only when they fail outside their own tests
	if (test.details?.type === "suite" && (!isFailed || error?.failureType === "subtestsFailed")) {
		return
	}

	// record the case with its suite path
	suite.assertionResults.push({
		status: toStatus(test, isFailed),
		fullName: [...ancestorTitles, test.name].join(" "),
		title: test.name,
		ancestorTitles,
	})
}

function toStatus(test: ReportedTest, isFailed: boolean): string {
	// report unfinished and skipped tests before their outcome
	if (test.todo !== undefined && test.todo !== false) {
		return "todo"
	}
	if (test.skip !== undefined && test.skip !== false) {
		return "pending"
	}

	// report the outcome of a completed test
	return isFailed ? "failed" : "passed"
}
