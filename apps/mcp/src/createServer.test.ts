import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { test } from "node:test"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import {
	createFakeSandboxProvider,
	InspectionError,
	inspectRepository,
	type SandboxFixture,
	type Upgrade,
} from "health-code"
import { parse as parseToml } from "smol-toml"
import { createServer } from "./createServer.ts"
import { environment, inspectionFixtureUrl, key, modelSettings, repo } from "./fixtures/inspectionSettings.ts"
import { requireSettings, toEnvironmentReference } from "./readEnvironmentSettings.ts"
import { setupAccount } from "./setupAccount.ts"
import { InspectionStore, protect } from "./storeInspection.ts"
import { Inspections } from "./trackInspections.ts"

test("setup registers and rotates a host-bound secret and prints model settings without credentials", async () => {
	// capture registrations without contacting the account service
	const stored: string[] = []
	const fake = {
		probe: async (): Promise<void> => {},
		check: async (token: string) => {
			assert.equal(token, environment.RUNTA_TOKEN)
		},
		store: async ({ name, key: storedKey }: { name: string; key: string }) => {
			stored.push(name)
			assert.ok(storedKey.startsWith(key))
		},
	}

	// parse both clients' settings and check their environment references
	const setup = { version: "1.2.3", client: fake }
	const output = await setupAccount({ ...environment, GITHUB_TOKEN: "separate-opt-in" }, setup)
	assert.ok(!output.includes(key) && !output.includes(environment.RUNTA_TOKEN))
	const entry = JSON.parse(`{${output.split("\n")[2]}}`)["health-code"]
	assert.equal(entry.env.MODEL_API_KEY, undefined)
	const config = parseToml(output.split("\n").at(-1) ?? "")
	assert.deepEqual(JSON.parse(JSON.stringify(config.mcp_servers)), {
		"health-code": {
			command: entry.command,
			args: entry.args,
			env_vars: ["RUNTA_TOKEN"],
			env: modelSettings,
		},
	})
	assert.deepEqual(entry.env, { RUNTA_TOKEN: toEnvironmentReference("RUNTA_TOKEN"), ...modelSettings })

	// verify the version-pinned launcher for this platform
	if (process.platform === "win32") {
		assert.equal(entry.command, "cmd.exe")
		assert.equal(entry.args.at(-1), 'cd /d "%USERPROFILE%" && npx -y health-code@1.2.3 mcp')
	} else {
		assert.equal(entry.command, "/bin/sh")
		assert.deepEqual(entry.args, ["-c", 'cd "$HOME" && exec npx "$@"', "npx", "-y", "health-code@1.2.3", "mcp"])
	}

	// rotate the secret in place and isolate registrations for other origins
	await setupAccount({ ...environment, MODEL_API_KEY: `${key}-rotated` }, setup)
	assert.equal(stored[0], stored[1])
	await setupAccount(
		{
			...environment,
			HEALTH_CODE_MODEL_HOST: "https://models.example.com",
		},
		setup,
	)
	assert.notEqual(stored[1], stored[2])
	await setupAccount({ ...environment, MODEL_API_KEY: undefined }, setup)
	assert.equal(stored.length, 3)

	// reject missing and unresolved credentials
	await assert.rejects(setupAccount({}, setup), /RUNTA_TOKEN, HEALTH_CODE_MODEL_HOST and HEALTH_CODE_MODEL/)
	await assert.rejects(setupAccount({ ...environment, MODEL_API_KEY: `\${MODEL_API_KEY}` }, setup), /MODEL_API_KEY/)

	// withhold credential-bearing messages from both setup failure paths
	for (const step of ["check", "store", "probe"]) {
		const broken = {
			...fake,
			[step]: async () => {
				throw new Error(key)
			},
		}
		await assert.rejects(
			setupAccount(environment, { ...setup, client: broken }),
			(error: Error) => !error.message.includes(key) && error.message.includes("failed"),
		)
	}
})

test("start returns before allocation, progress is request-scoped, and a new reader recovers the report", async () => {
	// hold sandbox allocation until the client has received its inspection id
	const root = await mkdtemp(join(tmpdir(), "mcp-inspection-"))
	const store = new InspectionStore(root, protect(environment))
	const fixture: SandboxFixture = JSON.parse(await readFile(inspectionFixtureUrl, "utf8"))
	const provider = createFakeSandboxProvider(fixture)
	const gate = Promise.withResolvers<void>()
	provider.checkAvailability = () => gate.promise

	// connect the client and server through paired in-memory transports
	const inspections = new Inspections(store, (options) => inspectRepository({ ...options, sandboxProvider: provider }))
	const server = createServer({ inspections, version: "1.2.3" })
	const client = new Client({ name: "offline-test", version: "1" })
	const [left, right] = InMemoryTransport.createLinkedPair()
	try {
		await Promise.all([server.connect(left), client.connect(right)])

		// check the public names and discovery titles together
		const tools = await client.listTools()
		assert.deepEqual(Object.fromEntries(tools.tools.map((tool) => [tool.name, tool.title])), {
			discover_upgrades: "Find available dependency upgrades",
			list_upgrades: "Browse dependency upgrades",
			get_upgrade_features: "Preview what’s new in this upgrade",
			get_tested_patch: "Get a tested patch by SHA-256",
			read_inspection: "Read progress and the inspection report",
			read_upgrade_results: "Read verdicts and patches",
			stop_inspection: "Stop an inspection",
			report_patch_result: "Record a patch result",
			start_inspection: "Start an inspection",
			get_upgrade: "Get a selected dependency upgrade",
		})
		for (const tool of tools.tools) {
			assert.ok(tool.title && tool.inputSchema && tool.outputSchema)
			assert.equal(
				tool.annotations?.openWorldHint,
				["discover_upgrades", "get_upgrade_features", "list_upgrades", "start_inspection", "get_upgrade"].includes(
					tool.name,
				),
			)
		}

		// attach one app view to the tools that open a screen
		const viewUri = "ui://health-code/view.html"
		assert.deepEqual(
			tools.tools
				.filter((tool) => tool._meta?.["ui/resourceUri"] === viewUri)
				.map((tool) => tool.name)
				.sort(),
			["get_upgrade", "list_upgrades", "start_inspection"],
		)
		const { resources } = await client.listResources()
		assert.deepEqual(
			resources.map(({ uri, mimeType }) => [uri, mimeType]),
			[[viewUri, "text/html;profile=mcp-app"]],
		)

		// capture progress on the initial request
		const startProgress: string[] = []
		const first = await client.callTool(
			{ name: "start_inspection", arguments: { repositoryUrl: repo } },
			{
				onprogress: (update) => {
					startProgress.push(String(update.message))
				},
			},
		)
		assert.equal(startProgress.length, 1)

		// distinguish concurrent inspections of the same repository
		const second = await inspections.start(repo)
		const id = String((first.structuredContent as { inspectionId: string }).inspectionId)
		assert.notEqual(id, second)

		// capture notifications for the read request separately
		const readProgress: string[] = []
		await client.callTool(
			{ name: "read_inspection", arguments: { inspectionId: id } },
			{
				onprogress: (update) => {
					readProgress.push(String(update.message))
				},
			},
		)
		assert.ok(readProgress.length)
		const delivered = readProgress.length
		const progress: string[] = []
		const live = await inspections.read(
			{ inspectionId: id, afterSequence: 0, reportOffset: 0, waitMs: 0 },
			{
				progress: async (step) => {
					progress.push(step)
				},
			},
		)
		assert.equal(live.status, "running")
		assert.ok(progress.length)

		// delay one reader until the report reaches disk
		const releaseProgress = Promise.withResolvers<void>()
		const pendingRead = inspections.read(
			{ inspectionId: id, afterSequence: 0, reportOffset: 0, waitMs: 0 },
			{ progress: () => releaseProgress.promise },
		)

		// release allocation and poll to completion
		gate.resolve()
		const end = Date.now() + 5000
		let snapshot = live
		while (snapshot.status === "running" && Date.now() < end) {
			snapshot = await inspections.read({
				inspectionId: id,
				afterSequence: snapshot.nextSequence,
				waitMs: 50,
				reportOffset: 0,
			})
		}
		assert.equal(snapshot.status, "complete")

		// compare the delayed reader with the final snapshot
		releaseProgress.resolve()
		assert.equal((await pendingRead).report?.text, snapshot.report?.text)
		assert.ok(snapshot.report?.text)
		assert.equal(readProgress.length, delivered)
		assert.equal(startProgress.length, 1)
		assert.ok(snapshot.pinned.some((event) => event.action === "deleted"))

		// reopen the report through a path with a trailing separator
		const replay = await new InspectionStore(root + sep).load(id)
		assert.equal(replay.repository.commit, fixture.commit)
		assert.equal(replay.timeline.at(-1)?.type, "inspection.finished")

		// return results without the report and refuse to stop a finished inspection
		const results = await client.callTool({ name: "read_upgrade_results", arguments: { inspectionId: id } })
		const recorded = results.structuredContent as { upgrades: { dependency: string; verdict?: string }[] }
		assert.deepEqual(
			recorded.upgrades.map(({ dependency, verdict }) => [dependency, verdict]),
			replay.upgrades.map(({ dependency, verdict }) => [dependency, verdict]),
		)
		const stop = await client.callTool({ name: "stop_inspection", arguments: { inspectionId: id } })
		assert.equal(stop.isError, true)

		// reject a digest absent from the recovered report
		const missing = await client.callTool({
			name: "get_tested_patch",
			arguments: { inspectionId: id, sha256: "a".repeat(64) },
		})
		assert.equal(missing.isError, true)
	} finally {
		// release pending allocation before closing transports and storage
		gate.resolve()
		await inspections.close()
		await client.close()
		await server.close()
		await rm(root, { recursive: true, force: true })
	}
})

test("storage failure keeps the completed evidence readable without restarting paid work", async () => {
	// occupy the storage path before starting the inspection
	const home = await mkdtemp(join(tmpdir(), "mcp-unwritable-"))
	const store = new InspectionStore(join(home, "file"))
	await writeFile(store.root, "occupied")
	const fixture: SandboxFixture = JSON.parse(await readFile(inspectionFixtureUrl, "utf8"))

	// count executions independently of failed save attempts
	let starts = 0
	const inspections = new Inspections(store, (options) => {
		starts++
		return inspectRepository({ ...options, sandboxProvider: createFakeSandboxProvider(fixture) })
	})
	try {
		// poll the accepted id through the persistence failure
		const id = await inspections.start(repo)
		let status = "running"
		const deadline = Date.now() + 5000
		while (status === "running" && Date.now() < deadline) {
			const view = await inspections.read({ inspectionId: id, afterSequence: 100000, waitMs: 300, reportOffset: 0 })
			status = view.status

			// require the completed report to remain available in memory
			if (status === "failed") {
				assert.match(view.failure ?? "", /memory only/)
				assert.equal((await inspections.loadReport(id)).inspectionId, id)
				assert.ok(view.report?.text)
			}
		}

		// verify the failed save never starts another inspection
		assert.equal(status, "failed")
		assert.equal(starts, 1)
	} finally {
		await inspections.close()
		await rm(home, { recursive: true, force: true })
	}
})

test("typed provider failure and cleanup stay associated with the accepted ID", async () => {
	const home = await mkdtemp(join(tmpdir(), "mcp-failure-"))
	const fake = createFakeSandboxProvider({ commit: "invalid", commands: [] })
	const inspections = new Inspections(new InspectionStore(home), (options) =>
		inspectRepository({ ...options, sandboxProvider: fake }),
	)
	try {
		// read the terminal failure through the original id
		const id = await inspections.start(repo)
		const view = await inspections.read({ inspectionId: id, afterSequence: 100000, waitMs: 5000, reportOffset: 0 })
		assert.equal(view.status, "failed")
		assert.match(view.failure ?? "", /repository-unavailable/)
		assert.ok(view.pinned.some((event) => event.action === "deleted"))
	} finally {
		// close the provider replay before removing its evidence
		await inspections.close()
		await rm(home, { recursive: true, force: true })
	}
})

test("stopping an inspection deletes its sandbox and ends with a terminal status", async () => {
	// hold the checkout after the sandbox exists
	const home = await mkdtemp(join(tmpdir(), "mcp-stop-"))
	const fixture: SandboxFixture = JSON.parse(await readFile(inspectionFixtureUrl, "utf8"))
	const provider = createFakeSandboxProvider(fixture)
	const created = Promise.withResolvers<void>()
	const gate = Promise.withResolvers<void>()

	// announce the sandbox before returning it
	const createSandbox = provider.createSandbox.bind(provider)
	provider.createSandbox = async (...input) => {
		const sandbox = await createSandbox(...input)
		created.resolve()
		await gate.promise
		return sandbox
	}

	// record each deletion
	const destroyed: string[] = []
	const destroySandbox = provider.destroySandbox.bind(provider)
	provider.destroySandbox = async (...input) => {
		destroyed.push(input[0].id)
		return destroySandbox(...input)
	}

	// run the inspection on the held provider
	const inspections = new Inspections(new InspectionStore(home), (options) =>
		inspectRepository({ ...options, sandboxProvider: provider }),
	)
	try {
		// stop the inspection while its sandbox exists
		const id = await inspections.start(repo)
		await created.promise
		inspections.stop(id)
		gate.resolve()

		// wait for the cancelled inspection to settle
		const end = Date.now() + 5000
		let status = "running"
		while (status === "running" && Date.now() < end) {
			const view = await inspections.read({ inspectionId: id, afterSequence: 0, waitMs: 50, reportOffset: 0 })
			status = view.status
		}

		// refuse to stop an inspection that already ended
		assert.equal(status, "failed")
		assert.equal(destroyed.length, 1)
		assert.throws(() => inspections.stop(id), /No active inspection/)
	} finally {
		// release the held sandbox before removing storage
		gate.resolve()
		await inspections.close()
		await rm(home, { recursive: true, force: true })
	}
})

test("a repeated request joins the running test of the same upgrade", async () => {
	// keep every inspection running until it is cancelled
	const started: string[] = []
	const cleanupFailure = new InspectionError("cancelled", "Cancelled")
	cleanupFailure.cleanupIds = ["sandbox-1"]
	const inspections = new Inspections(new InspectionStore(join(tmpdir(), "mcp-join")), ({ onEvent, signal }) => {
		// announce a distinct inspection for each start
		const id = crypto.randomUUID()
		started.push(id)
		const timestamp = new Date().toISOString()
		onEvent({ type: "inspection.started", version: 1, inspectionId: id, sequence: 1, timestamp, repositoryUrl: repo })
		return new Promise((_, reject) => signal.addEventListener("abort", () => reject(cleanupFailure)))
	})

	// start another inspection only for a different version or after a stop
	type Choice = { revision: string; upgrade: Upgrade }
	const choice = (to: string): Choice => ({
		revision: "a".repeat(40),
		upgrade: { dependency: "widget", from: { ".": "1.0.0" }, to, kind: "minor" },
	})
	const [first, joined] = await Promise.all([
		inspections.start(repo, choice("1.1.0")),
		inspections.start(repo, choice("1.1.0")),
	])
	assert.equal(joined, first)
	assert.notEqual(await inspections.start(repo, choice("1.2.0")), first)
	inspections.stop(first)
	assert.notEqual(await inspections.start(repo, choice("1.1.0")), first)
	assert.equal(started.length, 3)

	// keep a test that one request can cancel separate
	const request = { ...choice("2.0.0"), signal: new AbortController().signal }
	assert.notEqual(await inspections.start(repo, request), await inspections.start(repo, choice("2.0.0")))

	// name the sandbox whose deletion is unconfirmed
	await inspections.close()
	const view = await inspections.read({ inspectionId: first, afterSequence: 0, waitMs: 0, reportOffset: 0 })
	assert.match(view.failure ?? "", /deletion unconfirmed: sandbox-1/)
})

test("one error names every missing setting", () => {
	requireSettings(environment)
	const unresolved = { RUNTA_TOKEN: toEnvironmentReference("RUNTA_TOKEN") }
	assert.throws(() => requireSettings(unresolved), /RUNTA_TOKEN, HEALTH_CODE_MODEL_HOST and HEALTH_CODE_MODEL in/)
	assert.throws(() => requireSettings({ ...environment, HEALTH_CODE_MODEL: " " }), /^Error: Set HEALTH_CODE_MODEL in/)
})
