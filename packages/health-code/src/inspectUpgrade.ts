import { confirm, untested } from "./confirmCheck.ts"
import type { Baseline, CheckResult, EcosystemAdapter, Observation, UpgradeReport } from "./contracts.ts"

function installationReason(observation: Observation): string | undefined {
	if (observation.findings.length) {
		return "installation-finding"
	}
	return observation.complete ? undefined : "incomplete-observation"
}

/**
 * Compares the candidate install and repeated checks against the pinned Baseline.
 */
export async function inspectUpgrade({
	adapter,
	report,
	baseline,
	afterInstall,
}: {
	adapter: EcosystemAdapter
	report: UpgradeReport
	baseline: Baseline
	afterInstall?: () => Promise<void>
}): Promise<void> {
	// start each installation check from the pinned project
	await adapter.resetProject()
	const first = await adapter.bumpDependency(report)
	report.install = first.check
	report.observation = first.observation
	if (!installationReason(report.observation)) {
		report.install = await confirm(first.check, baseline.install, async () => {
			// recreate the upgrade to confirm a failing install
			await adapter.resetProject()
			const second = await adapter.bumpDependency(report)
			report.observation = second.observation
			return second.check
		})
	}
	// stop further checks when installation evidence is incomplete
	const reason = installationReason(report.observation)
	if (reason || report.install.status !== "passed") {
		report.result = reason ? untested(reason, report.install.evidence) : report.install
		report.tests = report.typecheck = untested(reason ?? "install-failed")
		return
	}
	// capture installed evidence before comparing test and typecheck results
	await afterInstall?.()
	if (!(await checkStages(adapter, report, baseline))) {
		return
	}
	const applicable = [
		report.install,
		...(adapter.project?.typecheck === "none" ? [] : [report.typecheck]),
		report.tests,
	]
	report.result = applicable.find((r) => r.status === "failed") ??
		applicable.find((r) => r.status === "untested") ?? {
			status: "passed",
			evidence: applicable.flatMap((r) => r.evidence),
		}
}

async function checkStages(adapter: EcosystemAdapter, report: UpgradeReport, baseline: Baseline): Promise<boolean> {
	for (const stage of ["typecheck", "tests"] as const) {
		// run and confirm each applicable check against the baseline
		const firstCheck = stage === "tests" ? await adapter.test() : await adapter.typecheck()
		report[stage] = await confirm(firstCheck, baseline[stage], () => repeatCheck(adapter, report, stage))
		const checked = report[stage]
		const interrupted =
			checked.status === "untested" &&
			["inspection-deadline", "confirmation-install-unavailable"].includes(checked.reason)
		// retain the observation or deadline reason that stopped the stage
		const reason = installationReason(report.observation) ?? (interrupted ? checked.reason : undefined)
		if (reason) {
			report.result = untested(reason, checked.evidence)
			if (stage === "typecheck") {
				report.tests = untested(reason)
			}
			// stop before running another stage after a blocking finding
			return false
		}
	}
	return true
}

async function repeatCheck(
	adapter: EcosystemAdapter,
	report: UpgradeReport,
	stage: "typecheck" | "tests",
): Promise<CheckResult> {
	// reinstall the upgrade on a freshly restored project
	await adapter.resetProject()
	const install = await adapter.bumpDependency(report)
	report.observation = install.observation
	report.install.evidence = [...report.install.evidence, ...install.check.evidence]
	if (install.check.status !== "passed" || installationReason(install.observation)) {
		return untested("confirmation-install-unavailable", install.check.evidence)
	}
	// rerun the failed stage with its build prerequisites
	if (stage === "typecheck") {
		return adapter.typecheck()
	}
	if (adapter.project?.typecheck !== "none") {
		const typecheck = await adapter.typecheck()
		// preserve a missing confirmation build as untested
		if (typecheck.status !== "passed") {
			return untested("confirmation-build-unavailable", typecheck.evidence)
		}
	}
	return adapter.test()
}
