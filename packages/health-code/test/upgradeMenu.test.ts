import assert from "node:assert/strict"
import { test } from "node:test"
import { toUpgradeMenu, type UpgradeMenuOrder, type UpgradeMenuTarget } from "../src/upgradeMenu.ts"

test("upgrade menu groups versions and sorts or filters individual dependency choices", () => {
	const targets: UpgradeMenuTarget[] = ["apple", "banana", "cherry"].map((dependency) => ({
		dependency,
		from: { ".": "1.0.0" },
		to: "2.0.0",
		kind: "major",
	}))
	const banana = targets[1]!
	targets.push({ ...banana, kind: "minor", to: "1.1.0", patch: { inspectionId: "report", sha256: "a".repeat(64) } })
	targets[2]!.from.child = "1.1.0"
	const names = (order: UpgradeMenuOrder): string[] =>
		toUpgradeMenu(targets, { order }).map((group) => group.dependency)

	// Alphabetical order breaks ties within the other two sorts.
	assert.deepEqual(names("minor"), ["banana", "apple", "cherry"])
	assert.deepEqual(names("alphabetical"), ["apple", "banana", "cherry"])
	assert.deepEqual(names("workspaces"), ["cherry", "apple", "banana"])

	// Keep the ready target without advertising the other version as tested.
	const [match] = toUpgradeMenu(targets, { search: " BAN ", readyOnly: true })
	assert.deepEqual(
		match?.targets.map((target) => target.to),
		["1.1.0"],
	)
	assert.equal(toUpgradeMenu(targets)[0]?.targets.length, 2)
})
