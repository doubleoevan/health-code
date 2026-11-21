import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { InspectionReport } from "health-code"
import { createInspectionLog } from "./inspect.ts"

const entry = fileURLToPath(new URL("./inspect.ts", import.meta.url))
const repositoryUrl = "https://github.com/example/project"

test("the active terminal line survives detail output and clears on failure", () => {
	const writes: string[] = []
	const log = createInspectionLog({ isTTY: true, columns: 30, write: (text) => writes.push(text) })
	const meta = { version: 1, inspectionId: "test", timestamp: "", sequence: 1, stepId: "install" } as const

	// replay a step interrupted by output and cancellation
	log({ ...meta, type: "step.started", label: "Install" })
	log({ ...meta, type: "detail", stream: "stdout", text: "\x1b[31mevidence\x1b[0m", truncated: false })
	log({ ...meta, type: "inspection.failed", code: "cancelled", message: "cancelled" })
	expect(writes.join("")).toBe("… Install\r\x1b[2K  stdout evidence\n… Install\r\x1b[2KInspection failed · cancelled\n")
})

test("fake inspection writes plain progress and a complete inspection report", () => {
	const cwd = mkdtempSync(join(tmpdir(), "health-code-cli-"))
	try {
		// run the recorded inspection without a terminal
		const child = spawnSync(process.execPath, [entry, repositoryUrl, "--fake"], { cwd, encoding: "utf8" })
		expect(child.status).toBe(0)
		expect(child.stdout).toContain("Fixture mode")
		expect(child.stdout).toContain("◆ deleted")
		expect(child.stdout).not.toContain("\x1b[")

		// locate the single saved inspection report
		const [filename, ...extra] = readdirSync(join(cwd, "logs"))
		expect(extra).toHaveLength(0)
		const report: InspectionReport = JSON.parse(readFileSync(join(cwd, "logs", filename ?? ""), "utf8"))
		expect(filename).toBe(`${report.inspectionId}.fake.json`)

		// verify the reported repository, result and final event
		expect(report.repository.url).toBe(repositoryUrl)
		expect(report.upgrades[0]?.result.status).toBe("passed")
		expect(report.timeline.at(-1)?.type).toBe("inspection.finished")
		expect(child.stdout).toContain(`Inspection report written to logs/${filename}`)
	} finally {
		rmSync(cwd, { recursive: true, force: true })
	}
})

test("invalid arguments exit before starting an inspection", () => {
	const child = spawnSync(process.execPath, [entry, repositoryUrl, "--unknown"], { encoding: "utf8" })
	expect(child.status).toBe(1)
	expect(child.stderr).toContain("Usage: bun run inspect <repo-url> [--fake]")
})

test("a replayed Model Request Sandbox startup event identifies the remote credential in the dev log", () => {
	const lines: string[] = []
	const log = createInspectionLog({ write: (text) => lines.push(text) })
	log({
		version: 2,
		inspectionId: "recorded",
		sequence: 4,
		timestamp: "",
		type: "sandbox.event",
		sandboxId: "recorded-relay",
		action: "model-request-sandbox-started",
		detail: "Runta supplies the model key.",
	})
	expect(lines.join("")).toContain("◆ model-request-sandbox-started Runta supplies the model key.")
})
