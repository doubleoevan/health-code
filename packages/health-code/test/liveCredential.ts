import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { registryHosts } from "../src/networkPolicy.ts"
import { connectProvider } from "../src/sandbox/createSandboxProvider.ts"

test("the live gateway authenticates only while the scoped model stub is attached", {
	skip: !process.env.RUNTA_TOKEN || !process.env.HEALTH_CODE_STORED_CREDENTIAL,
	timeout: 300000,
}, async () => {
	const provider = connectProvider({}, "7e6d81920e7959933822dc628fe7ad184f56cf61", true)
	const sandbox = { id: `health-code-${randomUUID()}` }
	const operation = { timeoutMs: 120000 }
	try {
		// prepare the pinned checkout under the registry policy
		await provider.createSandbox(sandbox.id, operation)
		await provider.prepareRepository(sandbox, "https://github.com/doubleoevan/health-code", operation)
		await provider.setNetworkPolicy(sandbox, registryHosts, operation)
		await provider.resetProject(sandbox, operation)

		// bind the configured credential name to the intended model endpoint
		const name = process.env.HEALTH_CODE_STORED_CREDENTIAL
		assert.ok(name)
		const route = {
			protocol: "anthropic" as const,
			baseUrl: "https://api.anthropic.com/v1",
			modelId: "claude-opus-5-5",
			credential: {
				name,
				header: "x-api-key",
				valueTemplate: `\${credential}`,
			},
		}
		assert.ok(provider.openCredentialSession)
		const session = await provider.openCredentialSession(sandbox, route, operation)
		try {
			// check that ordinary commands are blocked during the credential session
			await assert.rejects(
				provider.executeCommand(sandbox, { ...operation, argv: ["true"] }),
				/Registry policy required/,
			)

			// verify the authenticated model and its usage receipt
			const reply = await session.verify(operation)
			assert.equal(reply.modelId, route.modelId)
			assert.ok(typeof reply.inputTokens === "number" && typeof reply.outputTokens === "number")
		} finally {
			await session.close(operation)
		}

		// check that repository commands resume after closing the session
		assert.equal((await provider.executeCommand(sandbox, { ...operation, argv: ["true"] })).exitCode, 0)
		console.log("Live credential probe authenticated only with binding attached")
	} finally {
		await provider.destroySandbox(sandbox, { timeoutMs: 60000 })
	}
})
