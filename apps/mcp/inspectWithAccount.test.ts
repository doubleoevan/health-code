import assert from "node:assert/strict"
import { test } from "node:test"
import { createFakeSandboxProvider, InspectionError } from "health-code"
import { fetchPatch } from "./fetchPatch.ts"
import { modelRequestSandboxFixture } from "./fixtures/modelRequestSandboxInspection.ts"
import { inspectWithAccount } from "./inspectWithAccount.ts"
import { cardSchema, toHash } from "./storeInspection.ts"

test("the paid entry point routes each credential and closes the guest binding on a replay", async () => {
	const environment = {
		RUNTA_TOKEN: "synthetic-runta-token",
		ANTHROPIC_API_KEY: "synthetic-model-key",
		GITHUB_TOKEN: "synthetic-github-token",
	}
	const repositoryUrl = "https://github.com/example/project"
	const { provider, phases, mailbox, requested, restore } = await modelRequestSandboxFixture(
		createFakeSandboxProvider,
		environment.GITHUB_TOKEN,
	)

	try {
		const options = {
			repositoryUrl,
			sandboxProvider: provider,
			signal: new AbortController().signal,
			onEvent(): void {},
		}
		assert.throws(() => inspectWithAccount(options, {}), /RUNTA_TOKEN/)
		const card = await inspectWithAccount(options, { ...environment, ANTHROPIC_API_KEY: undefined })
		assert.equal(card.version, 2)
		assert.deepEqual(requested, ["registry", "releases"])
		assert.deepEqual(
			provider.modelRequestSandboxEvents.map((item) => item.request?.role ?? item.action),
			["open", "releaseSummary", "featureMatch", "close"],
		)
		assert.deepEqual(
			card.runtimeUsage?.runtimes.map((item) => [item.resource, item.deleted]),
			[
				["repository", true],
				["modelRequestSandbox", true],
			],
		)
		assert.deepEqual(phases, ["open", "verify", "generate", "close"])
		assert.ok(card.timeline.some((event) => event.type === "sandbox.event" && event.action === "agent-started"))
		assert.ok(!Object.values(environment).some((value) => JSON.stringify(card).includes(value)))
		// recover the exact mailbox and library prompt by digest
		const patch = fetchPatch(cardSchema.parse(card), { sha256: toHash(mailbox), offset: 0 })
		assert.equal(patch.text, mailbox)
		assert.equal(patch.agentPrompt, card.upgrades[0]?.patches[0]?.prompt)
	} finally {
		restore()
	}
})

test("failed inspections delete both runtimes independently and preserve all unresolved identities", async () => {
	for (const failure of [
		"callback",
		"partial create",
		"repository deletion",
		"model request sandbox deletion",
		"both deletions",
		"cancellation",
	]) {
		const { provider, restore } = await modelRequestSandboxFixture(createFakeSandboxProvider)
		const controller = new AbortController()
		const cleanupAttemptIds: string[] = []
		// Simulate a Model Request Sandbox deletion failure.
		const close = provider.modelRequestSandbox.close
		provider.modelRequestSandbox.close = async (name, op): Promise<void> => {
			cleanupAttemptIds.push(name)
			if (failure === "both deletions" || failure === "model request sandbox deletion") {
				throw new Error("Unconfirmed")
			}
			await close(name, op)
		}
		// Record each repository sandbox cleanup attempt.
		const destroy = provider.destroySandbox
		provider.destroySandbox = async (sandbox, op): Promise<void> => {
			cleanupAttemptIds.push(sandbox.id)
			if (failure === "both deletions" || failure === "repository deletion") {
				throw new Error("Unconfirmed")
			}
			await destroy(sandbox, op)
		}
		// Keep the requested identity when allocation cannot return a handle.
		if (failure === "partial create") {
			provider.modelRequestSandbox.open = async () => {
				throw new InspectionError("credential-binding", "Lost create reply")
			}
		}
		try {
			// Interrupt the Inspection after verified startup for the delivery scenarios.
			const inspection = inspectWithAccount(
				{
					repositoryUrl: "https://github.com/example/project",
					sandboxProvider: provider,
					signal: controller.signal,
					onEvent(event) {
						if (event.type === "sandbox.event" && event.action === "model-request-sandbox-started") {
							if (failure === "callback") {
								throw new Error("Delivery failed")
							}
							// Abort work while leaving both cleanup obligations active.
							if (failure === "cancellation") {
								controller.abort()
							}
						}
					},
				},
				{ RUNTA_TOKEN: "fixture" },
			)
			await assert.rejects(inspection, (error: unknown) => {
				assert.ok(error instanceof InspectionError)
				// A failed startup ends the Inspection before later Upgrades can request the same model request sandbox.
				if (failure === "partial create") {
					assert.equal(error.code, "model-request-sandbox-startup")
				}
				assert.equal(cleanupAttemptIds.length, 2)
				assert.equal(error.timeline.at(-1)?.type, "inspection.failed")
				if (failure.includes("deletion")) {
					// Compare the compatibility field with the full list of outstanding resources.
					const unresolved =
						failure === "both deletions"
							? cleanupAttemptIds
							: cleanupAttemptIds.filter(
									(name) => name.endsWith("-relay") === (failure === "model request sandbox deletion"),
								)
					assert.deepEqual(error.cleanupIds, unresolved)
					assert.equal(error.cleanupId, unresolved[0])
					assert.equal(error.runtimeUsage?.totalUpperBoundUsd, undefined)
					// Retain an independent reservation for each outstanding runtime.
					assert.deepEqual(
						error.runtimeUsage?.runtimes.filter((item) => !item.deleted).map((item) => item.id),
						unresolved,
					)
					assert.ok(
						error.runtimeUsage?.runtimes
							.filter((item) => !item.deleted)
							.every((item) => item.reservedUpperBoundUsd !== undefined),
					)
				}
				// Require the typed failure for every scenario.
				return true
			})
		} finally {
			restore()
		}
	}
})
