import {
	type Baseline,
	type CheckResult,
	InspectionError,
	type InspectionEvent,
	type InspectionReport,
	SandboxUnavailableError,
	type UpgradeReport,
} from "../contracts.ts"
import { ProjectEvidenceError, RegistryDeadlineError } from "../upgrades/parseRegistryVersions.ts"
import { toUpgradeKey } from "../upgrades/selectUpgrades.ts"
import { skippedUpgrade } from "./checkProject.ts"
import { toUpgradeInstallTimeout } from "./confirmCheck.ts"

const stages = ["install", "typecheck", "tests"] as const

function isUnfinished(check: CheckResult): boolean {
	return check.status === "untested" && ["not-run", "interrupted"].includes(check.reason)
}

/**
 * Preserves finished checks and identifies the work left after an interruption.
 */
export function preservePartialReport({
	report,
	error,
	activeUpgrade,
}: {
	report: InspectionReport
	error: unknown
	activeUpgrade?: string
}): void {
	// Record the interrupted target for a bounded retry after sandbox loss.
	if (error instanceof SandboxUnavailableError) {
		report.sandboxUnavailable = true
		report.interruptedUpgrade = activeUpgrade
	}

	// Identify the interrupted step using the event already recorded for it.
	const last = report.timeline.findLast((event) => event.type === "step.finished")
	const active = report.upgrades.find((item) => toUpgradeKey(item) === activeUpgrade)
	const reason = toStopReason(error)

	// Keep repository-wide stop reasons separate from a single upgrade timeout.
	report.stoppedReason = last?.status === "failed" ? `${reason} Last step: ${last.summary}.` : reason
	if ("reason" in report.packageManager) {
		report.packageManager = { reason }
	}
	if (error instanceof RegistryDeadlineError) {
		report.selection.registryLookupIssue = reason
	}

	// Keep evidence collected for the active upgrade before the interruption.
	const activeCheckReason = toInterruptedInstallDetail({ error, step: last, upgrade: active }) ?? reason
	if (last?.status === "failed") {
		markInterruptedCheck(active ?? report.baseline, last.summary, activeCheckReason)
	}

	// Preserve the completed stages on the active upgrade.
	if (active) {
		active.coverage = "partial"
		if (active.result.status === "untested" && active.result.reason === "not-run") {
			active.result = { ...active.result, detail: activeCheckReason }
		}
	}

	// Label selected upgrades the inspection never reached.
	report.selection.skipped.push(
		error instanceof InspectionError && error.code === "deadline" ? "inspection-deadline" : reason,
	)

	// Keep previously measured upgrades when the retry changes their execution order.
	const reached = new Set(report.upgrades.map(toUpgradeKey))
	const remaining = report.selection.selected.filter((upgrade) => !reached.has(toUpgradeKey(upgrade)))
	for (const upgrade of remaining) {
		const skipped = skippedUpgrade(upgrade, "not-run", reason)
		report.upgrades.push({ ...skipped, coverage: "skipped" })
	}
}

function toInterruptedInstallDetail({
	error,
	step,
	upgrade,
}: {
	error: unknown
	step?: Extract<InspectionEvent, { type: "step.finished" }>
	upgrade?: UpgradeReport
}): string | undefined {
	// Distinguish deadline expiry from an installation error or a lost sandbox.
	if (
		!(error instanceof InspectionError && error.code === "deadline") ||
		step?.status !== "failed" ||
		step.summary !== "install"
	) {
		return undefined
	}

	// Attribute the elapsed time only to this upgrade's unfinished installation.
	if (upgrade && step.upgradeId === toUpgradeKey(upgrade) && isUnfinished(upgrade.install)) {
		return toUpgradeInstallTimeout(step.durationMs)
	}
}

function toStopReason(error: unknown): string {
	if (error instanceof ProjectEvidenceError) {
		return error.message
	} else if (error instanceof InspectionError && error.code === "deadline") {
		return "The inspection reached its time limit."
	}

	// Preserve authentication, cancellation and cleanup failures as errors.
	if (error instanceof SandboxUnavailableError && error.reason === "unavailable") {
		return "The sandbox became unavailable."
	}
	throw error
}

function markInterruptedCheck(checks: Baseline, step: string, reason: string): void {
	if (step !== "tests" && step !== "typecheck" && step !== "install") {
		return
	}

	// Retain evidence already recorded before a confirmation attempt.
	const check = checks[step]
	if (check.status === "untested" && check.reason === "not-run") {
		checks[step] = { ...check, reason: "interrupted", detail: `Interrupted. ${reason}` }
	}
}

/**
 * Keeps earlier evidence when a replacement stops before reaching the same check.
 */
export function retainCompletedChecks(report: InspectionReport, previous: InspectionReport): void {
	for (const [index, upgrade] of report.upgrades.entries()) {
		if (!upgrade.coverage) {
			continue
		}

		// Restore an earlier target wholesale only when the replacement never started it.
		const earlier = previous.upgrades.find((item) => item.dependency === upgrade.dependency && item.to === upgrade.to)
		if (!earlier) {
			continue
		}
		if (upgrade.coverage === "skipped") {
			report.upgrades[index] = earlier
			continue
		}

		// Keep the installation observation with the command that produced it.
		const install = upgrade.install
		retainMeasuredStages(upgrade, earlier)
		if (upgrade.install !== install) {
			upgrade.observation = earlier.observation
		}

		// Restore an independently completed comparison only if the replacement has compatible evidence.
		if (
			isUnfinished(upgrade.result) &&
			earlier.result.status !== "untested" &&
			stages.every(
				(stage) =>
					upgrade[stage].status === earlier[stage].status &&
					(upgrade[stage].status !== "failed" || upgrade[stage] === earlier[stage]),
			)
		) {
			upgrade.result = earlier.result
		}
	}
}

export function retainMeasuredStages(checks: Baseline, previous: Baseline): void {
	for (const stage of stages) {
		const current = checks[stage]
		const earlier = previous[stage]

		// Preserve explicit outcomes such as install-failed on dependent stages.
		if (isUnfinished(current) && (earlier.status !== "untested" || earlier.evidence.length > 0)) {
			checks[stage] = earlier
		}
	}
}
