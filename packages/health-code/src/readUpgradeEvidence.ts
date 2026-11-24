import { z } from "zod"
import type { Locator } from "./agentContracts.ts"
import type { NodeAdapter } from "./checkProject.ts"
import type { CheckResult, InspectionReport } from "./contracts.ts"

export const usageEvidence = z.object({
	usage: z.array(
		z.object({
			file: z.string(),
			line: z.number().int().positive(),
			symbol: z.string(),
			workspace: z.string(),
			text: z.string(),
		}),
	),
	unresolved: z.array(z.string()),
	changelog: z.string(),
})
export type UsageEvidence = z.infer<typeof usageEvidence>
export async function sizeBytes(adapter: NodeAdapter): Promise<number | undefined> {
	// accept only a nonnegative integer size measurement
	const measured = await adapter.data(["installed-size"])
	return typeof measured === "number" && Number.isSafeInteger(measured) && measured >= 0 ? measured : undefined
}
export function permalink(repository: InspectionReport["repository"], file: string, line: number): string {
	// link evidence to the inspected file and line
	const path = file.split("/").map(encodeURIComponent).join("/")
	return `${repository.url.replace(/\.git$/, "")}/blob/${repository.commit}/${path}#L${line}`
}
export function diagnostics(checks: CheckResult[]): Locator[] {
	const locators = new Map<string, Locator>()

	// collect diagnostic locations only from failed checks
	for (const check of checks) {
		if (check.status === "failed") {
			readDiagnostics(check, locators)
			for (const test of check.failingTests) {
				const file = (test.workspace === "." ? "" : `${test.workspace}/`) + test.file

				// add suite failures without duplicating an existing source location
				if (![...locators.values()].some((loc) => loc.file === file)) {
					locators.set(file, { file, reason: "Test reporter supplied no line" })
				}
			}
		}
	}

	// bound the number of diagnostics returned for one upgrade
	return [...locators.values()].slice(0, 40)
}
function readDiagnostics(check: CheckResult, locators: Map<string, Locator>): void {
	for (const evidence of check.evidence) {
		for (const match of `${evidence.stdout}\n${evidence.stderr}`.matchAll(
			/(?:^|[ (])(?:\/project\/)?([\w.@/-]+\.[cm]?[jt]sx?)(?:\((\d+),\d+\)|:(\d+)(?::\d+)?)/gm,
		)) {
			// extract project-relative source locations from compiler output
			const file = match[1]
			if (!file) {
				continue
			}
			if (!file.startsWith("/") && !file.split("/").includes("..")) {
				// record the verified shape of each parsed line reference
				const line = Number(match[2] ?? match[3])
				locators.set(`${file}:${line}`, { file, line })
			}
		}
	}
}
export async function locateDiagnostics(options: {
	// describe the revision and reader for source verification
	repository: InspectionReport["repository"]
	locators: Locator[]
	read: (file: string) => Promise<string>
}): Promise<void> {
	const { repository, locators, read } = options
	const files = new Map<string, string | undefined>()

	// ignore diagnostics without a usable line number
	for (const locator of locators) {
		if (!locator.line) {
			continue
		}
		if (!files.has(locator.file)) {
			files.set(locator.file, await read(locator.file).catch(() => undefined))
		}

		// reject generated, unavailable or out-of-range source locations
		const text = files.get(locator.file)
		if (
			text === undefined ||
			/@generated\b/i.test(text.slice(0, 512)) ||
			/(?:^|\/)(?:dist|build|generated|node_modules)\//.test(locator.file) ||
			locator.line > text.split("\n").length
		) {
			// explain unavailable source evidence before adding a permalink
			locator.reason = "A tracked source line could not be verified"
			continue
		}
		locator.url = permalink(repository, locator.file, locator.line)
	}
}
