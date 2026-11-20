import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ReportCard } from "health-code"
import { createInspectionLog } from "./inspect.ts"

const entry = fileURLToPath(new URL("./inspect.ts", import.meta.url))
const repositoryUrl = "https://github.com/example/project"

test("the active terminal line survives detail output and clears on failure", () => {
	const writes: string[] = []
	const log = createInspectionLog({ isTTY: true, columns: 30, write: (text) => writes.push(text) })
	const meta = { version: 1, inspectionId: "test", timestamp: "", sequence: 1, stepId: "install" } as const
	log({ ...meta, type: "step.started", label: "Install" })
	log({ ...meta, type: "detail", stream: "stdout", text: "\x1b[31mevidence\x1b[0m", truncated: false })
	log({ ...meta, type: "inspection.failed", code: "cancelled", message: "cancelled" })
	expect(writes.join("")).toBe("… Install\r\x1b[2K  stdout evidence\n… Install\r\x1b[2KInspection failed · cancelled\n")
})

test("fake inspection writes plain progress and a complete report card", () => {
	const cwd = mkdtempSync(join(tmpdir(), "health-code-cli-"))
	try {
		const child = spawnSync(process.execPath, [entry, repositoryUrl, "--fake"], { cwd, encoding: "utf8" })
		expect(child.status).toBe(0)
		expect(child.stdout).toContain("Fixture mode")
		expect(child.stdout).toContain("◆ deleted")
		expect(child.stdout).not.toContain("\x1b[")
		const [filename, ...extra] = readdirSync(join(cwd, "logs"))
		expect(extra).toHaveLength(0)
		const card: ReportCard = JSON.parse(readFileSync(join(cwd, "logs", filename ?? ""), "utf8"))
		expect(filename).toBe(`${card.inspectionId}.fake.json`)
		expect(card.repository.url).toBe(repositoryUrl)
		expect(card.upgrades[0]?.result.status).toBe("passed")
		expect(card.timeline.at(-1)?.type).toBe("inspection.finished")
		expect(child.stdout).toContain(`Report card written to logs/${filename}`)
	} finally {
		rmSync(cwd, { recursive: true, force: true })
	}
})

test("invalid arguments exit before starting an inspection", () => {
	const child = spawnSync(process.execPath, [entry, repositoryUrl, "--unknown"], { encoding: "utf8" })
	expect(child.status).toBe(1)
	expect(child.stderr).toContain("Usage: bun run inspect <repo-url> [--fake]")
})
