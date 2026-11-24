import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TestInventory } from "../src/contracts.ts"
import { collectBunInventory, collectJsonInventory } from "./collectTestInventory.ts"

export function writeInventoryPages(directory: string, inventory: TestInventory): void {
	mkdirSync(directory)

	// write fixed-size inventory pages with file metadata on the first page
	for (let offset = 0; offset <= inventory.cases.length; offset += 100) {
		const page = {
			cases: inventory.cases.slice(offset, offset + 100).map(({ file, name, status }) => [file, name, status]),
			...(offset === 0
				? {
						discoveredFiles: inventory.discoveredFiles,
						testFileErrors: inventory.testFileErrors.map(({ file, reason }) => JSON.stringify([file, reason])).sort(),
					}
				: {}),
		}
		writeFileSync(join(directory, offset + ".json"), JSON.stringify(page), { flag: "wx", mode: 0o444 })
	}
}

/**
 * Runs tests and captures their reporter output on a size-limited filesystem.
 */
export function measureTests(directory: string, argv: string[]): number {
	// require the supervisor's capture directory and a test command
	const [file, ...args] = argv
	if (!file || !/^\/var\/lib\/health-code\/tests-[a-f0-9-]{36}$/.test(directory)) {
		throw new Error("Invalid test capture")
	}

	// mount a size-limited filesystem for reporter output
	mkdirSync(directory, { mode: 0o700 })
	const raw = join(directory, "raw")
	mkdirSync(raw)
	execFileSync("/usr/bin/mount", ["-t", "tmpfs", "-o", "size=16m,nosuid,nodev,noexec", "tmpfs", raw])
	try {
		// create a writable report before running repository tests
		const report = join(raw, "report")
		writeFileSync(report, "", { flag: "wx" })
		chmodSync(report, 0o666)
		const execution = spawnSync(file, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })

		// reject interrupted or incomplete test executions
		if (execution.error || execution.signal || execution.status === null) {
			throw new Error("Test process did not finish")
		}
		if (execution.status !== 0) {
			process.stderr.write(execution.stderr.slice(-60000))
		}

		// capture an empty inventory and keep the status of a runner without a report
		if (!statSync(report).size) {
			writeInventoryPages(join(directory, "inventory"), {
				counts: { passed: 0, failed: 0, skipped: 0, todo: 0 },
				cases: [],
				discoveredFiles: [],
				testFileErrors: [],
			})
			writeFileSync(join(directory, "report"), "")
			return execution.status
		}

		// reconcile the report with the runner's terminal evidence
		const text = readFileSync(report, "utf8")
		const inventory = text.trimStart().startsWith("<")
			? collectBunInventory(text, execution.stderr)
			: collectJsonInventory(text, "/project")
		writeInventoryPages(join(directory, "inventory"), inventory)
		copyFileSync(report, join(directory, "report"))

		// return captured totals and unmount temporary storage
		console.log(JSON.stringify({ counts: inventory.counts, testFileErrors: inventory.testFileErrors }))
		return execution.status
	} finally {
		execFileSync("/usr/bin/umount", ["--", raw])
	}
}
