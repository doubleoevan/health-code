import { createSandboxProvider, inspectRepository } from "health-code"
import { openBaseline } from "./evaluateBaseline.ts"
import { evaluateUpgrade } from "./evaluateUpgrade.ts"

async function evaluateBaseline(record: boolean, signal: AbortSignal): Promise<void> {
	const path = new URL("../evals/carlnotes-baseline.json", import.meta.url)
	const { fixture, finish } = await openBaseline(path, record)
	const started = Date.now()
	const sandboxProvider = createSandboxProvider({ memoryMib: 8192, revision: fixture.commit })
	const card = await inspectRepository({
		repositoryUrl: fixture.repositoryUrl,
		signal,
		sandboxProvider,
		limits: {
			maxUpgrades: 0,
			maxDurationMs: 3600000,
			maxCostUsd: 15,
			timeouts: { tests: 300000, install: 600000, typecheck: 600000 },
		},
		applicationEnvironment: "empty",
		includeTestInventory: true,
		onEvent(event) {
			if (event.type === "detail" && event.stream === "stderr") {
				const signature = event.text.match(/(?:out of memory|killed|signal|error TS\d+|heap limit)/i)?.[0]
				if (signature) {
					console.error("Command diagnostic", signature)
				}
			}
			if (event.type === "step.started") {
				console.error(event.label)
			}
			if (event.type === "step.finished") {
				console.error(event.status, `${Math.round(event.durationMs / 1000)}s`)
			}
		},
	})
	const observed = await finish(card)
	console.log(
		JSON.stringify({
			case: fixture.id,
			commit: fixture.commit,
			status: record ? "pending-review" : "passed",
			...observed,
			verdict: null,
			referenceDiff: null,
			durationMs: Date.now() - started,
			costUpperBoundUsd: sandboxProvider.estimateMaxCost(Date.now() - started),
		}),
	)
}

const controller = new AbortController()
const cancel = (): void => controller.abort()
process.on("SIGINT", cancel)
process.on("SIGTERM", cancel)
try {
	const args = process.argv.slice(2)
	if (args.join(" ") === "--case carlnotes-baseline --record" || args.join(" ") === "--case carlnotes-baseline") {
		await evaluateBaseline(args.includes("--record"), controller.signal)
	} else if (args.join(" ") === "--case typescript-7") {
		await evaluateUpgrade(controller.signal)
	} else if (args.join(" ") === "--all") {
		await evaluateUpgrade(controller.signal)
		await evaluateBaseline(false, controller.signal)
	} else {
		throw new Error("Expected --all or --case <id> [--record]")
	}
} finally {
	process.off("SIGINT", cancel)
	process.off("SIGTERM", cancel)
}
