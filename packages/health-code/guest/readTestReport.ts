import { existsSync } from "node:fs"
import { isAbsolute, relative } from "node:path"
import { XMLParser } from "fast-xml-parser"
import type { TestFailure } from "../src/contracts.ts"
import { readText, workspaceDirectories } from "./inventory.ts"

export const reportPath = ".health-code/test-results"
export function reporterArguments(script: string): string[] {
	if (!/^(?:bun test|vitest(?: run)?|jest)(?:\s+[\w./=-]+)*$/.test(script)) {
		return []
	}
	if (script.startsWith("bun test")) {
		return ["--reporter=junit", `--reporter-outfile=${reportPath}`]
	}
	if (script.startsWith("jest")) {
		return ["--json", `--outputFile=${reportPath}`, "--runInBand"]
	}
	return ["--run", "--reporter=json", `--outputFile=${reportPath}`]
}

type Suite = {
	name?: string
	status?: string
	message?: string
	assertionResults?: { status: string; fullName: string }[]
}
type XmlSuite = { name?: string; file?: string; testcase?: XmlCase[]; testsuite?: XmlSuite[]; errors?: string }
type XmlCase = { name?: string; classname?: string; file?: string; failure?: unknown; error?: unknown }

function fileName(path: string): string {
	return isAbsolute(path) ? relative(process.cwd(), path) : path
}
function xmlFailures(suites: XmlSuite[]): TestFailure[] {
	const failures: TestFailure[] = []
	for (const suite of suites) {
		failures.push(...xmlFailures(suite.testsuite ?? []))
		const cases = suite.testcase ?? []
		if (!cases.length && Number(suite.errors) > 0) {
			failures.push({ workspace: ".", file: fileName(suite.file ?? suite.name ?? "unknown") })
		}
		for (const item of cases) {
			if (item.failure !== undefined || item.error !== undefined) {
				failures.push({
					workspace: ".",
					file: fileName(item.file ?? suite.file ?? suite.name ?? "unknown"),
					name: [item.classname, item.name].filter(Boolean).join(" "),
				})
			}
		}
	}
	return failures
}
export function readTestReport(script: string): {
	complete: boolean
	granularity: "case" | "exit"
	failures: TestFailure[]
} {
	if (!reporterArguments(script).length) {
		return { complete: true, granularity: "exit", failures: [] }
	}
	if (!existsSync(reportPath)) {
		return { complete: false, granularity: "case", failures: [] }
	}
	const text = readText(reportPath)
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
		const suites = xml.testsuites?.testsuite ?? xml.testsuite
		if (!Array.isArray(suites)) {
			throw new Error("Invalid test report")
		}
		return { complete: true, granularity: "case", failures: scopeFailures(xmlFailures(suites)) }
	}
	return { complete: true, granularity: "case", failures: scopeFailures(jsonFailures(text)) }
}
function jsonFailures(text: string): TestFailure[] {
	const json = JSON.parse(text)
	if (!Array.isArray(json.testResults)) {
		throw new Error("Invalid test report")
	}
	const failures: TestFailure[] = []
	for (const suite of json.testResults as Suite[]) {
		const file = fileName(suite.name ?? "unknown")
		const failed = (suite.assertionResults ?? []).filter((test) => test.status === "failed")
		for (const test of failed) {
			failures.push({ workspace: ".", file, name: test.fullName })
		}
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
	const workspaces = workspaceDirectories()
	return failures.map((failure) => {
		const workspace = workspaces.find((dir) => failure.file.startsWith(`${dir}/`))
		return workspace ? { ...failure, workspace, file: relative(workspace, failure.file) } : failure
	})
}
