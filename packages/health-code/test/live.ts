import assert from "node:assert/strict"
import { test } from "node:test"
import { inspectRepository } from "../src/inspectRepository.ts"
import { connectProvider } from "../src/sandbox/createSandboxProvider.ts"
import { fixtureCommit, fixtureUrl, providerContract } from "./providerContract.ts"

const skip = !process.env.RUNTA_TOKEN

test("live sandbox provider contract", { skip, timeout: 480000 }, async () => {
	await providerContract(connectProvider({}, fixtureCommit))
})
for (const [url, commit] of [
	[fixtureUrl, fixtureCommit],
	["https://github.com/privatenumber/get-tsconfig", "b4e7751e408eeaf014974a7cb1ec2634914a4d6c"],
] as const) {
	test(`pinned Baseline ${url}`, { skip, timeout: 600000 }, async () => {
		// inspect the pinned commit with upgrade trials disabled
		const started = Date.now()
		const sandboxProvider = connectProvider({}, commit)
		const card = await inspectRepository({
			repositoryUrl: url,
			sandboxProvider,
			limits: { maxUpgrades: 0, maxDurationMs: 540000 },
		})

		// confirm the pinned baseline produced installation evidence
		assert.equal(card.repository.commit, commit)
		assert.ok("name" in card.packageManager, JSON.stringify(card.packageManager))
		assert.ok(card.baseline.install.evidence.length, "Missing Baseline installation evidence")
		if (url === fixtureUrl) {
			// Exercise oxlint's sparse allocator through Nano ID's pinned test script.
			assert.equal(card.baseline.tests.status, "passed", JSON.stringify(card.baseline.tests))
		}

		// report cleanup, elapsed time and the provider cost estimate
		assert.ok(card.timeline.some((e) => e.type === "sandbox.event" && e.action === "deleted"))
		console.log(
			JSON.stringify({
				commit,
				baseline: card.baseline.install.status,
				installEvidence: card.baseline.install.evidence.map((e) => (e.stderr || e.stdout).slice(-450)),
				durationMs: Date.now() - started,
				costUpperBoundUsd: sandboxProvider.estimateMaxCost(Date.now() - started),
				deleted: true,
			}),
		)
	})
}
