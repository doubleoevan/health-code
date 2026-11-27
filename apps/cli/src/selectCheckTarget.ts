import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
	type InspectionEvent,
	listUpgrades,
	type MinimumReleaseAge,
	resolveUpgrade,
	toReleaseAgeNotice,
	type UpgradeMenu,
} from "health-code"
import type { InspectOptions } from "./inspectWithAccount.ts"
import { toEventLine } from "./toEventLine.ts"

// what a check tests
export type CheckTarget = { kind: "upgrade"; choice: Partial<InspectOptions> } | { kind: "none"; isComplete: boolean }

type SelectCheckTargetOptions = {
	// the repository, the commit and the version the caller named
	repositoryUrl: string
	revision?: string
	dependency?: string
	to?: string

	// where the menu is saved and how GitHub and the registry are reached
	output: string
	githubToken?: string
	signal: AbortSignal
	request?: typeof fetch
	log: (line: string) => void
}

/**
 * Resolves a named version, or builds the upgrade menu and picks its first target.
 */
export async function selectCheckTarget({
	dependency,
	to,
	output,
	log,
	...options
}: SelectCheckTargetOptions): Promise<CheckTarget> {
	// print each step as it starts
	const onEvent = (event: InspectionEvent): void => {
		if (event.type === "step.started") {
			log(toEventLine(event))
		}
	}
	if (dependency && to) {
		return resolveNamedTarget({ ...options, dependency, to, onEvent, log })
	}

	// save the menu for the pipeline before deciding what to test
	const upgradeMenu = await listUpgrades({ ...options, onEvent })
	await mkdir(output, { recursive: true })
	await writeFile(join(output, "upgrade-menu.json"), `${JSON.stringify(upgradeMenu, null, 2)}\n`)
	return selectUpgradeMenuTarget(upgradeMenu, log)
}

async function resolveNamedTarget({
	dependency,
	to,
	log,
	...options
}: Omit<SelectCheckTargetOptions, "output" | "dependency" | "to"> & {
	dependency: string
	to: string
	onEvent: (event: InspectionEvent) => void
}): Promise<CheckTarget> {
	// check the named version against the committed files and the registry
	const resolveUpgradeResult = await resolveUpgrade({ ...options, dependency, to })
	const revision = resolveUpgradeResult.repository.commit
	logAssumedReleaseAge(resolveUpgradeResult.minimumReleaseAge, log)

	// leave the check to the sandbox when the committed files cannot be read from GitHub
	if (!resolveUpgradeResult.upgrade) {
		log(resolveUpgradeResult.unreadable?.message ?? "The project could not be read from GitHub.")
		log("Checking the version in a sandbox instead.")
		return { kind: "upgrade", choice: { revision, upgrade: { dependency, to }, mode: "inspectUpgrades" } }
	}
	return { kind: "upgrade", choice: { revision, upgrade: resolveUpgradeResult.upgrade, mode: "inspectUpgrades" } }
}

function selectUpgradeMenuTarget(upgradeMenu: UpgradeMenu, log: (line: string) => void): CheckTarget {
	const revision = upgradeMenu.repository.commit
	logAssumedReleaseAge(upgradeMenu.minimumReleaseAge, log)

	// list in a sandbox when the committed files cannot be read from GitHub
	if (upgradeMenu.unreadable) {
		log(upgradeMenu.unreadable.message)
		log("Listing upgrades in a sandbox instead.")
		return { kind: "upgrade", choice: { revision, limits: { maxUpgrades: 1 } } }
	}

	// test the menu's first target. minor upgrades sort first, then names
	const upgrade = upgradeMenu.dependencies[0]?.targets[0]
	if (upgrade) {
		return { kind: "upgrade", choice: { revision, upgrade, mode: "inspectUpgrades" } }
	}

	// report an issue as an incomplete check
	if (upgradeMenu.issue) {
		log(upgradeMenu.issue)
		return { kind: "none", isComplete: false }
	}
	log(`No eligible upgrade at ${revision}.`)
	return { kind: "none", isComplete: true }
}

// say when the minimum release age was assumed, with the value that was applied
function logAssumedReleaseAge(minimumReleaseAge: MinimumReleaseAge | undefined, log: (line: string) => void): void {
	if (minimumReleaseAge?.isAssumed) {
		log(toReleaseAgeNotice(minimumReleaseAge))
	}
}
