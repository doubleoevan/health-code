import { writeFileSync } from "node:fs"
import { InspectionError, listUpgrades } from "health-code"
import { upgradeMenuFailedMessage } from "./buildUpgradeMenu.ts"

type ListUpgradesOptions = Parameters<typeof listUpgrades>[0]

// ask the kernel to end this process before the server when the container runs out of memory
try {
	writeFileSync("/proc/self/oom_score_adj", "1000")
} catch {
	// only linux has the setting
}

// build one upgrade menu per message and report its events, its result or its typed failure
process.on("message", async (options: ListUpgradesOptions): Promise<void> => {
	try {
		const upgradeMenu = await listUpgrades({
			...options,
			onEvent: (event): void => {
				process.send?.({ kind: "event", event })
			},
		})
		process.send?.({ kind: "upgradeMenu", upgradeMenu })
	} catch (error) {
		// keep an unexpected error's text inside this process
		const failure =
			error instanceof InspectionError
				? { code: error.code, message: error.message, retryAt: error.retryAt }
				: { code: "menu-failed", message: upgradeMenuFailedMessage }
		process.send?.({ kind: "failure", ...failure })
	}
})
