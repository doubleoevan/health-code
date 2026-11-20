import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import {
	createFakeSandboxProvider,
	createSandboxProvider,
	InspectionError,
	type InspectionEvent,
	inspectRepository,
} from "health-code"

type Output = { isTTY?: boolean; columns?: number; write: (text: string) => unknown }

function toLogLines(event: Exclude<InspectionEvent, { type: "step.started" }>): string[] {
	switch (event.type) {
		case "inspection.started":
			return [`Inspecting ${event.repositoryUrl}`]
		case "step.finished":
			return [`${event.summary} ${event.status} (${event.durationMs} ms)`]
		case "sandbox.event":
			return [`◆ ${event.action}${event.detail ? ` ${event.detail}` : ""}`]
		case "detail": {
			const lines = event.text
				.trimEnd()
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => `  ${event.stream} ${line}`)
			if (event.truncated) {
				lines.push(`  ${event.stream} output truncated`)
			}
			return lines
		}
		case "inspection.finished":
			return [`Inspection finished · ${event.inspected} upgrade(s)`]
		case "inspection.failed":
			return [`Inspection failed · ${event.message}`]
	}
}

function toPrintable(value: string): string {
	return [...stripVTControlCharacters(value)]
		.filter((char) => {
			const code = char.charCodeAt(0)
			return code >= 32 && (code < 127 || code > 159)
		})
		.join("")
}

function toActiveStep(event: InspectionEvent, current: string): string {
	switch (event.type) {
		case "step.started":
			return toPrintable(`… ${event.label}${event.upgradeId ? ` [${event.upgradeId}]` : ""}`)
		case "step.finished":
		case "inspection.finished":
		case "inspection.failed":
			return ""
		default:
			return current
	}
}

/**
 * Keeps the active step on the last terminal line while evidence scrolls above it.
 */
export function createInspectionLog(output: Output): (event: InspectionEvent) => void {
	let active = ""
	return (event) => {
		if (active && output.isTTY) {
			output.write("\r\x1b[2K")
		}
		active = toActiveStep(event, active)
		if (event.type === "step.started" && !output.isTTY) {
			output.write(`${active}\n`)
		}
		if (event.type !== "step.started") {
			for (const line of toLogLines(event)) {
				output.write(`${toPrintable(line)}\n`)
			}
		}
		if (output.isTTY) {
			output.write(Bun.wrapAnsi(active, Math.max(2, (output.columns ?? 80) - 1), { hard: true }).split("\n")[0] ?? "")
		}
	}
}

async function main(args: string[]): Promise<void> {
	const [repositoryUrl, flag, ...remaining] = args
	if (
		!repositoryUrl ||
		repositoryUrl.startsWith("-") ||
		remaining.length ||
		(flag !== undefined && flag !== "--fake")
	) {
		throw new Error("Usage: bun run inspect <repo-url> [--fake]")
	}
	const fake = flag === "--fake"
	const recording = new URL("./fixtures/recorded/inspection.json", import.meta.url)
	const sandboxProvider = fake ? createFakeSandboxProvider(await Bun.file(recording).json()) : createSandboxProvider()
	if (fake) {
		console.log("Fixture mode · replaying recorded evidence")
	}
	const controller = new AbortController()
	const cancel = (): void => controller.abort()
	process.on("SIGINT", cancel)
	process.on("SIGTERM", cancel)
	try {
		const card = await inspectRepository({
			repositoryUrl,
			sandboxProvider,
			onEvent: createInspectionLog(process.stdout),
			signal: controller.signal,
		})
		await mkdir("logs", { recursive: true })
		const path = join("logs", `${card.inspectionId + (fake ? ".fake" : "")}.json`)
		const temporary = `${path}.tmp`
		try {
			await writeFile(temporary, `${JSON.stringify(card, null, 2)}\n`, { flag: "wx", mode: 0o600 })
			await rename(temporary, path)
		} finally {
			await rm(temporary, { force: true })
		}
		console.log(`Report card written to ${path}`)
	} finally {
		process.off("SIGINT", cancel)
		process.off("SIGTERM", cancel)
	}
}
if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "Inspection failed"
		console.error(error instanceof InspectionError ? `${error.code} · ${message}` : message)
		process.exitCode = 1
	})
}
