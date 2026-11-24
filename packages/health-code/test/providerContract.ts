import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { SandboxProvider } from "../src/contracts.ts"

export const fixtureUrl = "https://github.com/ai/nanoid"
export const fixtureCommit = "055d1700cc67ac843e3efb5235d806b419ec7b2b"
export const controlCommand = [
	"sh",
	"-c",
	"printf observed > /tmp/health-code-evidence; rm /tmp/health-code-evidence; printf stdout; printf stderr >&2",
]
export const registryCommand = [
	"curl",
	"--silent",
	"--show-error",
	"--fail",
	"--max-time",
	"12",
	"--output",
	"/dev/null",
	"https://registry.npmjs.org/is-number",
]
export const outsideCommand = [
	"curl",
	"--silent",
	"--show-error",
	"--max-time",
	"4",
	"--output",
	"/dev/null",
	"https://example.com/",
]
export async function providerContract(provider: SandboxProvider): Promise<void> {
	// reserve a unique sandbox name for cleanup after any failure
	const options = { timeoutMs: 300000 }
	const name = `health-code-${randomUUID()}`
	let allocated = { id: name }
	try {
		// prepare the inspected checkout and restrict egress to the registry
		await provider.checkAvailability({ timeoutMs: 10000 })
		allocated = await provider.createSandbox(name, options)
		assert.equal(await provider.prepareRepository(allocated, fixtureUrl, options), fixtureCommit)
		await provider.setNetworkPolicy(allocated, ["registry.npmjs.org"], options)
		await provider.resetProject(allocated, options)

		// verify a file round trip in the restored project
		await provider.writeFile(allocated, "contract.txt", "first", options)
		assert.equal(await provider.readFile(allocated, "contract.txt", options), "first")

		// observe a command that writes outside the project
		const result = await provider.executeCommand(allocated, { argv: controlCommand, timeoutMs: 15000, observe: true })
		assert.equal(result.exitCode, 0, result.stderr)
		assert.equal(result.stdout, "stdout")
		assert.equal(result.stderr, "stderr")
		assert.ok(result.observationId)

		// check that file observation retains a transient write
		const writes = await provider.readFileChanges(allocated, result.observationId)
		assert.ok(writes.complete, JSON.stringify(writes))
		assert.ok(
			writes.findings.some((x) => x.kind === "write" && x.path === "/tmp/health-code-evidence"),
			JSON.stringify(writes),
		)
		assert.equal((await provider.readAttemptedConnections(allocated, result.observationId)).complete, true)

		// exercise registry access and a blocked external destination
		const allowed = await provider.executeCommand(allocated, { argv: registryCommand, timeoutMs: 15000 })
		assert.equal(allowed.exitCode, 0, allowed.stderr)
		const outside = await provider.executeCommand(allocated, { argv: outsideCommand, observe: true, timeoutMs: 10000 })
		assert.notEqual(outside.exitCode, 0, "Registry policy admitted an off-list request")
		assert.ok(outside.observationId)

		// match the blocked request to its network evidence
		const network = await provider.readAttemptedConnections(allocated, outside.observationId)
		assert.ok(
			network.findings.some((f) => f.kind === "connection" && f.destination === "example.com"),
			JSON.stringify(network),
		)

		// bound a long-running command and check that reset removes temporary files
		const timeout = await provider.executeCommand(allocated, { argv: ["sleep", "5"], timeoutMs: 1000 })
		assert.notEqual(timeout.exitCode, 0)
		await provider.resetProject(allocated, options)
		await assert.rejects(provider.readFile(allocated, "contract.txt", options))
	} finally {
		await provider.destroySandbox(allocated, { timeoutMs: 60000 })
	}
}
