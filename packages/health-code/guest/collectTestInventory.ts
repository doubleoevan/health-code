import { isAbsolute, normalize } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { TestCase, TestCounts, TestInventory } from "../src/contracts.ts"
import { jsonCaseName, xmlCaseName } from "../src/testCaseName.ts"

type Suite = {
	file?: string
	name?: string
	testsuite?: Suite[]
	// identify test cases within each reported suite
	testcase?: {
		file?: string
		classname?: string
		name?: string
		// retain the outcome elements supplied by the reporter
		failure?: unknown
		error?: unknown
		skipped?: { message?: string } | string
	}[]
}

function toCaseStatus(test: NonNullable<Suite["testcase"]>[number]): TestCase["status"] {
	// give failures precedence over skipped or pending status
	return test.failure !== undefined || test.error !== undefined
		? "failed"
		: test.skipped === undefined
			? "passed"
			: typeof test.skipped === "object" && test.skipped.message === "TODO"
				? "todo"
				: "skipped"
}
/** Reconciles the Bun reporter with its separately reported file loading errors. */
export function collectBunInventory(xml: string, stderr: string): TestInventory {
	if (/<!DOCTYPE/i.test(xml)) {
		throw new Error("Unexpected report declaration")
	}
	const parsed = new XMLParser({
		ignoreAttributes: false,
		attributeNamePrefix: "",
		processEntities: false,
		parseAttributeValue: false,
		isArray: (name) => name === "testsuite" || name === "testcase",
	}).parse(xml)
	// require a suite list before counting test cases
	const root = parsed.testsuites
	if (!Array.isArray(root?.testsuite)) {
		throw new Error("Missing test suites")
	}
	const cases: TestCase[] = []
	const discoveredFiles = new Set<string>()
	const counts: TestCounts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
	// visit nested suites and retain their file identities
	function visit(suite: Suite): void {
		if (suite.file) {
			discoveredFiles.add(projectFile(suite.file))
		}
		for (const test of suite.testcase ?? []) {
			// attribute each case to its own file or its suite
			const file = projectFile(test.file ?? suite.file)
			discoveredFiles.add(file)
			if (!test.name) {
				throw new Error("Unnamed test case")
			}
			// record the named case and its observed status
			const status = toCaseStatus(test)
			cases.push({
				file,
				name: xmlCaseName(test.name, test.classname),
				status,
			})
			counts[status]++
		}
		// descend into suites nested under this one
		for (const nested of suite.testsuite ?? []) {
			visit(nested)
		}
	}
	for (const suite of root.testsuite as Suite[]) {
		visit(suite)
	}
	// reconcile file discovery errors with the terminal totals
	const { errorCount, testFileErrors } = readTestFileErrors(stderr)
	const terminal = /Ran \d+ tests? across \d+ files?\.[^\n]*\s*(?:error: script [^\n]*\s*)?$/.exec(stderr.trimEnd())
	if (!terminal || Number(root.tests) !== cases.length) {
		throw new Error("Incomplete Bun test inventory")
	}
	// isolate the final summary paragraph from earlier output
	const tail =
		stderr
			.slice(0, terminal.index)
			.trimEnd()
			.split(/\n\s*\n/)
			.at(-1) ?? ""
	// extract the runner's status counts
	const observed = Object.fromEntries(
		[...tail.matchAll(/^\s*(\d+) (pass|skip|todo|fail|error)s?\s*$/gm)].map((match) => [match[2], Number(match[1])]),
	)
	if (
		counts.passed !== (observed.pass ?? 0) ||
		counts.skipped !== (observed.skip ?? 0) ||
		counts.todo !== (observed.todo ?? 0) ||
		counts.failed + errorCount !== (observed.fail ?? 0) ||
		// compare errors from file loading separately from case failures
		errorCount !== (observed.error ?? 0)
	) {
		throw new Error(
			`Bun totals disagree: ${JSON.stringify({ counts, observed, errorCount, suites: testFileErrors.size })}`,
		)
	}
	return {
		counts,
		cases,
		discoveredFiles: [...new Set([...discoveredFiles, ...testFileErrors.keys()])].sort(),
		testFileErrors: [...testFileErrors]
			.sort(([first], [second]) => first.localeCompare(second))
			.map(([path, reason]) => ({ file: path, reason })),
	}
}

function readTestFileErrors(stderr: string): { errorCount: number; testFileErrors: Map<string, string> } {
	// Bun omits suites that fail during discovery from JUnit.
	const lines = stderr.split(/\r?\n/)
	let file = ""
	let errorCount = 0
	const testFileErrors = new Map<string, string>()
	// associate each discovery error with the last file header
	for (const [i, line] of lines.entries()) {
		const header = /^([^\s].*\.[cm]?[jt]sx?):$/.exec(line)
		if (header) {
			file = projectFile(header[1])
		}
		// skip diagnostics outside a file loading failure
		if (line !== "# Unhandled error between tests") {
			continue
		}
		if (!file) {
			throw new Error("Unattributed file loading error")
		}
		// keep the first useful diagnostic for the current file
		const diagnostic = lines.slice(i + 1, i + 40).find((entry) => /^(?:\w*Error|error): /.test(entry))
		testFileErrors.set(file, (diagnostic ?? "Unhandled error between tests").replaceAll("/project/", "").slice(0, 320))
		errorCount++
	}
	return { errorCount, testFileErrors }
}
// validate file identities before merging reporters
function projectFile(value?: string): string {
	if (
		!value ||
		isAbsolute(value) ||
		normalize(value).split("/").includes("..") ||
		// exclude control characters that could disguise a reported path
		[...value].some((char) => char.charCodeAt(0) < 32)
	) {
		throw new Error("Unusable test file identity")
	}
	// use one normalized key per test file
	return normalize(value)
}

/** Reads Jest and Vitest case identities and suite-level errors from their JSON reporters. */
export function collectJsonInventory(text: string, root = process.cwd()): TestInventory {
	const report = JSON.parse(text)
	if (!Array.isArray(report.testResults) || !Number.isSafeInteger(report.numTotalTests)) {
		throw new Error("Incomplete JSON test inventory")
	}
	// collect case totals and suite failures separately
	const counts: TestCounts = { passed: 0, failed: 0, skipped: 0, todo: 0 }
	const cases: TestCase[] = []
	const discoveredFiles = new Set<string>()
	const testFileErrors: TestInventory["testFileErrors"] = []
	for (const suite of report.testResults) {
		// resolve the suite's file against the project root
		const file = projectFile(String(suite.name ?? "").replace(`${root}/`, ""))
		discoveredFiles.add(file)
		if (!Array.isArray(suite.assertionResults)) {
			throw new Error("Missing test identities")
		}
		// count each named assertion once
		for (const assertion of suite.assertionResults) {
			const entry = toJsonCase(file, assertion)
			counts[entry.status]++
			cases.push(entry)
		}
		// retain suite failures without a failing assertion
		if (
			suite.status === "failed" &&
			!suite.assertionResults.some((entry: { status: string }) => entry.status === "failed")
		) {
			testFileErrors.push({ file, reason: "Suite failed before reporting a failing test" })
		}
	}
	// cross-check the collected counts against the json summary
	if (
		cases.length !== report.numTotalTests ||
		counts.passed !== report.numPassedTests ||
		counts.failed !== report.numFailedTests
	) {
		throw new Error("JSON test totals disagree")
	}
	// return stable file and error ordering
	return {
		counts,
		cases,
		discoveredFiles: [...discoveredFiles].sort(),
		testFileErrors: testFileErrors.sort((a, b) => a.file.localeCompare(b.file)),
	}
}
function toJsonCase(
	file: string,
	assertion: { status: string; fullName?: string; title?: string; ancestorTitles?: string[] },
): TestCase {
	const status = ["pending", "disabled"].includes(assertion.status) ? "skipped" : assertion.status
	if (!["passed", "failed", "skipped", "todo"].includes(status)) {
		throw new Error("Unknown JSON test result")
	}
	return { file, name: jsonCaseName(assertion), status: status as keyof TestCounts }
}
