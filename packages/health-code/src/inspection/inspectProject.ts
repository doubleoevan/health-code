import { NodeAdapter, pending, skippedUpgrade } from "../checks/checkProject.ts"
import { inspectUpgrade } from "../checks/inspectUpgrade.ts"
import { preservePartialReport, retainCompletedChecks } from "../checks/preservePartialReport.ts"
import { sizeBytes } from "../checks/readUpgradeEvidence.ts"
import type { InspectionContext } from "../collectEvents.ts"
import type { InspectionReport, Sandbox } from "../contracts.ts"
import { readPatchVerificationInputs } from "../patches/verifyCandidate.ts"
import { toUpgradeKey } from "../upgrades/selectUpgrades.ts"
import type { ModelInspection } from "./inspectModels.ts"

export async function inspectProject({
	context,
	sandbox,
	repository,
	engine,
	previous,
}: {
	context: InspectionContext
	sandbox: Sandbox
	repository: InspectionReport["repository"]
	engine?: ModelInspection
	previous?: InspectionReport
}): Promise<InspectionReport> {
	// Establish independent project state for each verified checkout.
	const adapter = new NodeAdapter(context, sandbox)
	adapter.watchChecks = !!engine
	const inspectionReport: InspectionReport = {
		version: 1,
		inspectionId: context.id,
		repository,
		packageManager: { reason: "project-not-detected" },
		baseline: pending("not-run"),
		selection: previous?.selection.selected.length
			? { ...previous.selection, skipped: previous.selection.skipped.slice(0, -1) }
			: {
					mode: context.options.mode,
					limit: context.maximum,
					selected: [],
					eligible: [],
					omitted: [],
					skipped: [],
				},
		upgrades: [],
		timeline: context.timeline,
	}
	try {
		// restore the inspected tree before detecting the project
		await adapter.resetProject()
		const project = await adapter.detectProject()
		inspectionReport.packageManager = { name: project.manager, version: project.version }
		if (!inspectionReport.selection.selected.length) {
			Object.assign(inspectionReport.selection, await adapter.listUpgrades(project, context.maximum))
		}

		// Return the upgrade menu before allocating an installation or model budget.
		if (context.options.mode === "listUpgrades") {
			inspectionReport.selection.selected = []
			inspectionReport.selection.omitted = []
			return inspectionReport
		}
		engine?.restoreUpgrades(inspectionReport)
		await engine?.captureUsage(
			adapter,
			inspectionReport.selection.selected
				.filter((upgrade) => !engine.reused.has(toUpgradeKey(upgrade)))
				.map((upgrade) => upgrade.dependency),
		)
		inspectionReport.baseline.install = await adapter.installBaseline()

		// capture installation evidence for baseline comparisons
		if (engine) {
			engine.baseInstall = adapter.lastObservation
			engine.baseSize = await sizeBytes(adapter).catch(() => undefined)
		}
		if (inspectionReport.baseline.install.status === "passed") {
			inspectionReport.baseline.typecheck = await adapter.typecheck()
			inspectionReport.baseline.tests = await adapter.test()

			// retain baseline test coverage for independent patch checks
			if (engine) {
				engine.baseTests = adapter.lastObservation
				engine.baselinePatchVerificationInputs = await readPatchVerificationInputs(adapter).catch(() => undefined)
			}
		}

		// Finish each upgrade and its optional adoption before starting the next.
		await inspectSelected({ context, adapter, inspectionReport, sandbox, engine, previous })
	} catch (error) {
		preservePartialReport({ report: inspectionReport, error, activeUpgrade: context.upgradeId })
	} finally {
		// clear the upgrade identity before returning the partial report
		context.upgradeId = undefined
	}
	if (previous) {
		retainCompletedChecks(inspectionReport, previous)

		// Publish targets in upgrade menu order after an out-of-order retry.
		const order = new Map(inspectionReport.selection.selected.map((target, index) => [toUpgradeKey(target), index]))
		inspectionReport.upgrades.sort((a, b) => (order.get(toUpgradeKey(a)) ?? 0) - (order.get(toUpgradeKey(b)) ?? 0))
	}
	return inspectionReport
}

async function inspectSelected({
	context,
	adapter,
	inspectionReport,
	sandbox,
	engine,
	previous,
}: {
	context: InspectionContext
	adapter: NodeAdapter
	inspectionReport: InspectionReport
	sandbox: Sandbox
	engine?: ModelInspection
	previous?: InspectionReport
}): Promise<void> {
	// Require the original installation before running upgrade checks.
	const installPassed = inspectionReport.baseline.install.status === "passed"

	// Give untouched targets a turn before retrying the upgrade that lost the sandbox.
	const targets = inspectionReport.selection.selected
	const interrupted = previous?.interruptedUpgrade
	const work = targets.slice()
	const index = work.findIndex((target) => toUpgradeKey(target) === interrupted)
	if (index >= 0) {
		work.push(...work.splice(index, 1))
	}

	// Recover each target independently from its previous evidence.
	for (const upgrade of work) {
		context.upgradeId = toUpgradeKey(upgrade)

		// Link finished results from the same revision before running fresh checks.
		const completed = previous?.upgrades.find(
			(item) => item.dependency === upgrade.dependency && item.to === upgrade.to && !item.coverage,
		)
		const cached = engine?.reused.get(context.upgradeId) ?? completed
		if (cached) {
			inspectionReport.upgrades.push(cached)
			continue
		}

		// Retain a selected upgrade even if its first check loses the sandbox.
		const report = skippedUpgrade(upgrade, "not-run")
		inspectionReport.upgrades.push(report)
		if (!installPassed) {
			report.coverage = "skipped"
			report.result = {
				status: "untested",
				reason: "baseline-unavailable",
				detail: "Health Code could not install the original dependencies before trying this upgrade.",
				evidence: [],
			}
			continue
		}

		// Compare each check with the evidence available on the original commit.
		await inspectUpgrade({
			adapter,
			report,
			baseline: inspectionReport.baseline,
			afterInstall: engine ? () => engine.captureInstallation(adapter, report) : undefined,
		})
		await engine?.inspect(context, adapter, sandbox, inspectionReport, report)
	}
}
