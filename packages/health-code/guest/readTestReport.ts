import { existsSync, readFileSync, statSync } from "node:fs"
import { isAbsolute, relative } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { TestFailure } from "../src/contracts.ts"
import { jsonCaseName, xmlCaseName } from "../src/testCaseName.ts"
import { readText, workspaceDirectories } from "./inventory.ts"

export const reportPath = ".health-code/test-results"

// the bundle uploaded next to the project tool
const nodeReporter = "/opt/health-code/nodeTestReporter.mjs"

// the flags that leave the reporter and the loaded modules unchanged
const nodeTestFlag = /^--(?:test-(?:concurrency|timeout)=\d+|test-force-exit|experimental-[\w-]+)$/

/**
 * Recognizes scripts whose last command runs Node's test runner directly or through tsx.
 */
export function isNodeTestScript(script: string): boolean {
	// read the last command's arguments
	const [runner, ...args] = toLastCommand(script)
		.replace(/\s--import(?:=|\s+)tsx(?=\s)/, "")
		.split(/\s+/)

	// allow only the runner, known flags and test files
	return (
		(runner === "tsx" || runner === "node") &&
		args.includes("--test") &&
		args.every((arg) => arg === "--test" || nodeTestFlag.test(arg) || /^["']?[\w.@*][\w./@*-]*["']?$/.test(arg))
	)
}

/**
 * Adds the JSON reporter to Node's test runner through its environment.
 */
export function reporterEnvironment(script: string, path = reportPath): NodeJS.ProcessEnv {
	if (!isNodeTestScript(script)) {
		return {}
	}

	// keep the readable output beside the structured report
	const options = [
		"--test-reporter=spec",
		"--test-reporter-destination=stdout",
		`--test-reporter=${nodeReporter}`,
		`--test-reporter-destination=${path}`,
	]
	return { NODE_OPTIONS: [process.env.NODE_OPTIONS, ...options].filter(Boolean).join(" ") }
}

// package managers append arguments to the last command in a script
function toLastCommand(script: string): string {
	return /[;|<>`$\n]/.test(script) ? "" : (script.split("&&").at(-1)?.trim() ?? "")
}

export function reporterArguments(script: string, path = reportPath): string[] {
	const command = toLastCommand(script)
	if (!/^(?:bun test|vitest(?: run)?|jest)(?:\s+[\w./=-]+)*$/.test(command)) {
		return []
	}

	// choose the runner's supported machine-readable reporter
	if (command.startsWith("bun test")) {
		return ["--reporter=junit", `--reporter-outfile=${path}`]
	}
	if (command.startsWith("jest")) {
		return ["--json", `--outputFile=${path}`, "--runInBand"]
	}
	return ["--run", "--reporter=json", `--outputFile=${path}`]
}

type Suite = {
	name?: string
	status?: string
	message?: string
	assertionResults?: { status: string; fullName: string; title?: string; ancestorTitles?: string[] }[]
}
type XmlSuite = { name?: string; file?: string; testcase?: XmlCase[]; testsuite?: XmlSuite[]; errors?: string }
type XmlCase = { name?: string; classname?: string; file?: string; failure?: unknown; error?: unknown }

function fileName(path: string): string {
	return isAbsolute(path) ? relative(process.cwd(), path) : path
}

// use structured identities when matching protected test cases
function reportedXmlName(item: XmlCase, structured: boolean): string {
	return structured && item.name
		? xmlCaseName(item.name, item.classname)
		: [item.classname, item.name].filter(Boolean).join(" ")
}
function xmlFailures(suites: XmlSuite[], structured: boolean): TestFailure[] {
	// collect failures recursively from nested xml suites
	const failures: TestFailure[] = []
	for (const suite of suites) {
		failures.push(...xmlFailures(suite.testsuite ?? [], structured))
		const cases = suite.testcase ?? []
		if (!cases.length && Number(suite.errors) > 0) {
			failures.push({ workspace: ".", file: fileName(suite.file ?? suite.name ?? "unknown") })
		}

		// retain the reported file for each failing case
		for (const item of cases) {
			if (item.failure !== undefined || item.error !== undefined) {
				failures.push({
					workspace: ".",
					file: fileName(item.file ?? suite.file ?? suite.name ?? "unknown"),
					name: reportedXmlName(item, structured),
				})
			}
		}
	}
	return failures
}
export function readTestReport(
	script: string,
	protectedReport = false,
): {
	complete: boolean
	granularity: "case" | "exit"
	failures: TestFailure[]
} {
	// use exit status for scripts without structured reporters
	if (!reporterArguments(script).length && !isNodeTestScript(script)) {
		return { complete: true, granularity: "exit", failures: [] }
	}
	const path = protectedReport ? "/inspection-report" : reportPath
	if (!existsSync(path) || statSync(path).size > 16 * 1024 * 1024) {
		return { complete: false, granularity: "case", failures: [] }
	}

	// parse the bounded report using its detected format
	const text = protectedReport ? readFileSync(path, "utf8") : readText(path)
	if (text.trimStart().startsWith("<")) {
		if (/<!DOCTYPE/i.test(text)) {
			throw new Error("Unsupported report declaration")
		}
		const xml = new XMLParser({
			ignoreAttributes: false,
			attributeNamePrefix: "",
			processEntities: false,
			isArray: (name) => name === "testsuite" || name === "testcase",
		}).parse(text)

		// require a suite list before accepting xml results
		const suites = xml.testsuites?.testsuite ?? xml.testsuite
		if (!Array.isArray(suites)) {
			throw new Error("Invalid test report")
		}
		return { complete: true, granularity: "case", failures: scopeFailures(xmlFailures(suites, protectedReport)) }
	}
	return { complete: true, granularity: "case", failures: scopeFailures(jsonFailures(text, protectedReport)) }
}

// extract case and suite failures from the json reporter
function jsonFailures(text: string, structured: boolean): TestFailure[] {
	const json = JSON.parse(text)
	if (!Array.isArray(json.testResults)) {
		throw new Error("Invalid test report")
	}
	const failures: TestFailure[] = []
	for (const suite of json.testResults as Suite[]) {
		// group failing assertions by their originating file
		const file = fileName(suite.name ?? "unknown")
		const failed = (suite.assertionResults ?? []).filter((test) => test.status === "failed")
		for (const test of failed) {
			failures.push({ workspace: ".", file, name: structured ? jsonCaseName(test) : test.fullName })
		}

		// retain suite-level failures without individual case results
		if (!failed.length && suite.status === "failed") {
			failures.push({ workspace: ".", file })
		}
	}
	return failures
}

function scopeFailures(failures: TestFailure[]): TestFailure[] {
	if (!failures.length) {
		return failures
	}

	// attribute each failed file to its owning workspace
	const workspaces = workspaceDirectories()
	return failures.map((failure) => {
		const workspace = workspaces.find((dir) => failure.file.startsWith(`${dir}/`))
		return workspace ? { ...failure, workspace, file: relative(workspace, failure.file) } : failure
	})
}
