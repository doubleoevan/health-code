import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { TestInventory } from "../src/contracts.ts"
import { collectBunInventory, collectJsonInventory } from "./collectTestInventory.ts"

export function writeInventoryPages(directory: string, inventory: TestInventory): void {
	mkdirSync(directory)
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

/** The separate filesystem limits reporter output without restricting the project's own test files. */
export function measureTests(directory: string, argv: string[]): number {
	const [file, ...args] = argv
	if (!file || !/^\/var\/lib\/health-code\/tests-[a-f0-9-]{36}$/.test(directory)) {
		throw new Error("Invalid test capture")
	}
	mkdirSync(directory, { mode: 0o700 })
	const raw = join(directory, "raw")
	mkdirSync(raw)
	execFileSync("/usr/bin/mount", ["-t", "tmpfs", "-o", "size=16m,nosuid,nodev,noexec", "tmpfs", raw])
	try {
		const report = join(raw, "report")
		writeFileSync(report, "", { flag: "wx" })
		chmodSync(report, 0o666)
		const execution = spawnSync(file, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
		if (execution.error || execution.signal || execution.status === null) {
			throw new Error("Test process did not finish")
		}
		if (execution.status !== 0) {
			process.stderr.write(execution.stderr.slice(-60000))
		}
		if (!statSync(report).size) {
			return execution.status
		}
		const text = readFileSync(report, "utf8")
		const inventory = text.trimStart().startsWith("<")
			? collectBunInventory(text, execution.stderr)
			: collectJsonInventory(text, "/project")
		writeInventoryPages(join(directory, "inventory"), inventory)
		copyFileSync(report, join(directory, "report"))
		console.log(JSON.stringify({ counts: inventory.counts, testFileErrors: inventory.testFileErrors }))
		return execution.status
	} finally {
		execFileSync("/usr/bin/umount", ["--", raw])
	}
}
