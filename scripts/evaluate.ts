import { createSandboxProvider, inspectRepository } from "health-code"
import { openBaseline } from "./evaluateBaseline.ts"
import { evaluateUpgrade, upgradeCaseIds } from "./evaluateUpgrade.ts"

async function evaluateBaseline(record: boolean, signal: AbortSignal): Promise<void> {
	// load the baseline case and select its recording mode
	const path = new URL("../evals/baseline-test-counts.json", import.meta.url)
	const { fixture, finish } = await openBaseline(path, record)
	const started = Date.now()

	// inspect the test inventory with upgrades disabled
	const sandboxProvider = createSandboxProvider({ memoryMib: 8192, revision: fixture.commit })
	const report = await inspectRepository({
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
			// print recognized failure signatures from command output
			if (event.type === "detail" && event.stream === "stderr") {
				const signature = event.text.match(/(?:out of memory|killed|signal|error TS\d+|heap limit)/i)?.[0]
				if (signature) {
					console.error("Command diagnostic", signature)
				}
			}

			// report step progress and elapsed time
			if (event.type === "step.started") {
				console.error(event.label)
			}
			if (event.type === "step.finished") {
				console.error(event.status, `${Math.round(event.durationMs / 1000)}s`)
			}
		},
	})

	// score or record the observed inventory and its cost
	const observed = await finish(report)
	console.log(
		JSON.stringify({
			case: fixture.id,
			commit: fixture.commit,
			status: record ? "pending-review" : "passed",
			promptVersions: report.promptVersions,
			...observed,
			verdict: null,
			referenceDiff: null,
			durationMs: Date.now() - started,
			costUpperBoundUsd: sandboxProvider.estimateMaxCost(Date.now() - started),
		}),
	)
}

// cancel the active evaluation on shutdown
const controller = new AbortController()
const cancel = (): void => controller.abort()
process.on("SIGINT", cancel)
process.on("SIGTERM", cancel)
try {
	// dispatch the selected evaluation case
	const args = process.argv.slice(2)
	const upgradeCaseId = upgradeCaseIds.find((id) => args.join(" ") === `--case ${id}`)
	if (args.join(" ") === "--case baseline-test-counts --record" || args.join(" ") === "--case baseline-test-counts") {
		await evaluateBaseline(args.includes("--record"), controller.signal)
	} else if (upgradeCaseId) {
		await evaluateUpgrade(upgradeCaseId, controller.signal)
	} else if (args.join(" ") === "--all") {
		// run every case against its recorded expectations
		for (const id of upgradeCaseIds) {
			await evaluateUpgrade(id, controller.signal).catch((error: unknown) => {
				// score the remaining cases unless the evaluation was cancelled
				controller.signal.throwIfAborted()

				// report the failed case in the exit code
				console.error(id, error)
				process.exitCode = 1
			})
		}

		// score the Baseline after every upgrade case
		await evaluateBaseline(false, controller.signal)
	} else {
		throw new Error("Expected --all or --case <id> [--record]")
	}
} finally {
	// release the signal handlers after evaluation
	process.off("SIGINT", cancel)
	process.off("SIGTERM", cancel)
}
