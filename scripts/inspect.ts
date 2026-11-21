import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { stripVTControlCharacters } from "node:util"
import {
	createFakeSandboxProvider,
	createSandboxProvider,
	InspectionError,
	type InspectionEvent,
	inspectRepository,
	type ModelRequestSandboxEvent,
} from "health-code"

type LogEvent = InspectionEvent | ModelRequestSandboxEvent

type Output = { isTTY?: boolean; columns?: number; write: (text: string) => unknown }

function toLogLines(event: Exclude<LogEvent, { type: "step.started" }>): string[] {
	switch (event.type) {
		// format inspection and step milestones
		case "inspection.started":
			return [`Inspecting ${event.repositoryUrl}`]
		case "step.finished":
			return [`${event.summary} ${event.status} (${event.durationMs} ms)`]
		case "sandbox.event":
			return [`◆ ${event.action}${event.detail ? ` ${event.detail}` : ""}`]

		// label each line of captured command output
		case "detail": {
			const lines = event.text
				.trimEnd()
				.split(/\r?\n/)
				.filter(Boolean)
				.map((line) => `  ${event.stream} ${line}`)

			// mark incomplete output at the end of its stream
			if (event.truncated) {
				lines.push(`  ${event.stream} output truncated`)
			}
			return lines
		}

		// report the terminal inspection outcome
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

function toActiveStep(event: LogEvent, current: string): string {
	switch (event.type) {
		// show the current step until it or the inspection ends
		case "step.started":
			return toPrintable(`… ${event.label}${event.upgradeId ? ` [${event.upgradeId}]` : ""}`)
		case "step.finished":
		case "inspection.finished":
		case "inspection.failed":
			return ""

		// preserve the active step across detail events
		default:
			return current
	}
}

/**
 * Keeps the active step on the last terminal line while evidence scrolls above it.
 */
export function createInspectionLog(output: Output): (event: LogEvent) => void {
	let active = ""
	return (event) => {
		// clear the previous progress line before appending evidence
		if (active && output.isTTY) {
			output.write("\r\x1b[2K")
		}
		active = toActiveStep(event, active)
		if (event.type === "step.started" && !output.isTTY) {
			output.write(`${active}\n`)
		}

		// write permanent log lines for completed work and output
		if (event.type !== "step.started") {
			for (const line of toLogLines(event)) {
				output.write(`${toPrintable(line)}\n`)
			}
		}

		// redraw the current step within the terminal width
		if (output.isTTY) {
			output.write(Bun.wrapAnsi(active, Math.max(2, (output.columns ?? 80) - 1), { hard: true }).split("\n")[0] ?? "")
		}
	}
}

async function main(args: string[]): Promise<void> {
	const [repositoryUrl, flag, ...remaining] = args

	// reject extra arguments before selecting a provider
	if (
		!repositoryUrl ||
		repositoryUrl.startsWith("-") ||
		remaining.length ||
		(flag !== undefined && flag !== "--fake")
	) {
		throw new Error("Usage: bun run inspect <repo-url> [--fake]")
	}

	// select the recorded or live sandbox provider
	const fake = flag === "--fake"
	const recording = new URL("./fixtures/recorded/inspection.json", import.meta.url)
	const sandboxProvider = fake ? createFakeSandboxProvider(await Bun.file(recording).json()) : createSandboxProvider()
	if (fake) {
		console.log("Fixture mode · replaying recorded evidence")
	}

	// forward process cancellation to the inspection
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

		// save the report privately under its inspection id
		await mkdir("logs", { recursive: true })
		const path = join("logs", `${card.inspectionId + (fake ? ".fake" : "")}.json`)
		const temporary = `${path}.tmp`
		try {
			await writeFile(temporary, `${JSON.stringify(card, null, 2)}\n`, { flag: "wx", mode: 0o600 })
			await rename(temporary, path)
		} finally {
			// remove partial output after a write or rename failure
			await rm(temporary, { force: true })
		}
		console.log(`Report card written to ${path}`)
	} finally {
		process.off("SIGINT", cancel)
		process.off("SIGTERM", cancel)
	}
}

// map command failures to a nonzero exit status
if (import.meta.main) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		const message = error instanceof Error ? error.message : "Inspection failed"
		console.error(error instanceof InspectionError ? `${error.code} · ${message}` : message)
		process.exitCode = 1
	})
}
