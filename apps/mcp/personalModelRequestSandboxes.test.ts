import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createFakeSandboxProvider } from "health-code"
import { configureModels } from "./configureModels.ts"
import { modelSettings } from "./fixtures/inspectionSettings.ts"
import { organizationFolder, recordOwnership, recoverModelRequestSandboxes } from "./personalModelRequestSandboxes.ts"
import { probeModelRequestSandbox } from "./probeModelRequestSandbox.ts"

const route = configureModels(modelSettings).releaseSummary
test("personal recovery protects live owners and ignores unrecorded or malformed names", async () => {
	// Isolate the owner journal under a fresh private directory.
	const folder = await mkdtemp(join(tmpdir(), "relay-owners-"))
	const fake = createFakeSandboxProvider({ commit: "", commands: [] })
	const modelRequestSandbox = recordOwnership(fake.modelRequestSandbox, folder)
	const name = `health-code-${randomUUID()}-relay`
	const deadName = `health-code-${randomUUID()}-relay`

	// A live owner keeps its journal entry until acknowledged deletion.
	const operation = { timeoutMs: 30000 }
	try {
		await modelRequestSandbox.open(name, route, operation)
		assert.deepEqual(await readdir(folder), [`${process.pid}.${name}`])

		// A PID beyond the system allocation range is a confirmed dead owner.
		await writeFile(join(folder, `99999999.${deadName}`), "")
		await writeFile(join(folder, `99999999.${deadName}-lookalike`), "")
		await recoverModelRequestSandboxes({ modelRequestSandbox: fake.modelRequestSandbox, folder })
		await recoverModelRequestSandboxes({ modelRequestSandbox: fake.modelRequestSandbox, folder })
		assert.deepEqual(
			fake.modelRequestSandboxEvents.map(({ id, action }) => [id, action]),
			[
				[name, "open"],
				[deadName, "close"],
			],
		)
		await modelRequestSandbox.close(name, operation)
		assert.deepEqual(await readdir(folder), [`99999999.${deadName}-lookalike`])
	} finally {
		await rm(folder, { recursive: true, force: true })
	}
})

test("setup sends a single one-token probe and withholds success until deletion", async () => {
	const accepted = { modelId: "fixture", text: "K", inputTokens: 4, outputTokens: 1 }
	for (const fail of [undefined, "open", "send", "close"] as const) {
		const fake = createFakeSandboxProvider({
			commit: "",
			commands: [],
			modelRequestSandbox: { replies: [accepted], fail },
		})
		const check = probeModelRequestSandbox({
			modelRequestSandbox: fake.modelRequestSandbox,
			route,
			end: Date.now() + 120000,
		})

		// Require confirmed deletion before setup can succeed.
		if (fail) {
			await assert.rejects(check, fail === "close" ? /cleanup failed.*health-code-/ : /verification failed/)
		} else {
			await check
		}

		// Count only authenticated inference requests.
		const requests = fake.modelRequestSandboxEvents.filter((item) => item.action === "send")
		assert.equal(requests.length, fail === "open" ? 0 : 1)
		if (requests.length) {
			assert.equal(requests[0]?.request?.output, 1)
		}

		// Check cleanup after every probe outcome.
		assert.equal(fake.modelRequestSandboxEvents.at(-1)?.action, "close")
	}
})

test("recovery shares the setup deadline and identifies the model request sandbox still awaiting cleanup", async () => {
	const folder = await mkdtemp(join(tmpdir(), "relay-deadline-"))
	const fake = createFakeSandboxProvider({ commit: "", commands: [] })
	const now = Date.now
	const end = now() + 120000
	let clock = end - 120000

	// Five deletions would need 150 seconds if each received the full allowance.
	const slices: number[] = []
	try {
		for (let index = 0; index < 5; index++) {
			await writeFile(join(folder, `99999999.health-code-${randomUUID()}-relay`), "")
		}

		// Advance the simulated clock by exactly the allowance for each successful deletion.
		Date.now = () => clock
		fake.modelRequestSandbox.close = async (_, operation) => {
			slices.push(operation.timeoutMs)
			clock += operation.timeoutMs
		}
		const remaining = await recoverModelRequestSandboxes({
			modelRequestSandbox: fake.modelRequestSandbox,
			folder,
			end,
		}).catch((error: Error) => error.message)

		// Leave the first unattempted model request sandbox recoverable by name.
		const records = await readdir(folder)
		assert.equal(records.length, 1)
		const name = records[0]?.slice("99999999.".length)
		assert.ok(name && remaining?.includes(name))
		assert.deepEqual(slices, [30000, 30000, 30000, 30000])

		// Hide upstream errors and keep the same record for a later recovery.
		fake.modelRequestSandbox.close = async () => {
			throw new Error("upstream diagnostic")
		}
		await assert.rejects(
			recoverModelRequestSandboxes({ modelRequestSandbox: fake.modelRequestSandbox, folder }),
			(error) => error instanceof Error && error.message.includes(name) && !error.message.includes("upstream"),
		)
		assert.deepEqual(await readdir(folder), records)
	} finally {
		Date.now = now
		await rm(folder, { recursive: true, force: true })
	}
})

test("rotating the token preserves the verified organization scope", async () => {
	const end = Date.now() + 10000
	const request = (async (_url, init) => {
		const account = new Headers(init?.headers).get("authorization") === "Bearer other" ? "two" : "one"
		return Response.json({ organization_id: account })
	}) as typeof fetch

	// Account boundaries survive a change of credential.
	const first = await organizationFolder({ token: "initial", end, request })
	assert.equal(await organizationFolder({ token: "rotated", end, request }), first)
	assert.notEqual(await organizationFolder({ token: "other", end, request }), first)

	// separate a rejected token from missing access and an outage
	for (const [status, reason] of [
		[401, "authentication"],
		[403, "permission"],
		[503, "unavailable"],
	] as const) {
		const refused = async (): Promise<Response> => new Response("", { status })
		await assert.rejects(organizationFolder({ token: "initial", end, request: refused }), { reason })
	}
	const offline = (): Promise<Response> => Promise.reject(new TypeError("fetch failed"))
	await assert.rejects(organizationFolder({ token: "initial", end, request: offline }), { reason: "unavailable" })
})
