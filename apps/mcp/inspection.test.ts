import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { test } from "node:test"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { createFakeSandboxProvider, inspectRepository, type SandboxFixture } from "health-code"
import { parse as parseToml } from "smol-toml"
import { createServer } from "./createServer.ts"
import { environment, inspectionFixtureUrl, key, repo } from "./fixtures/inspectionSettings.ts"
import { setupAccount } from "./setupAccount.ts"
import { InspectionStore, protect } from "./storeInspection.ts"
import { Inspections } from "./trackInspections.ts"

test("setup registers and rotates a host-bound secret and prints name-only client settings", async () => {
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
	assert.equal(entry.env.ANTHROPIC_API_KEY, undefined)
	const config = parseToml(output.split("\n").at(-1) ?? "")
	assert.deepEqual(JSON.parse(JSON.stringify(config.mcp_servers)), {
		"health-code": {
			command: entry.command,
			args: entry.args,
			env_vars: ["RUNTA_TOKEN", "HEALTH_CODE_SUMMARY_MODEL"],
		},
	})

	// verify the version-pinned launcher for this platform
	if (process.platform === "win32") {
		assert.equal(entry.command, "cmd.exe")
		assert.equal(entry.args.at(-1), 'cd /d "%USERPROFILE%" && npx -y health-code@1.2.3 mcp')
	} else {
		assert.equal(entry.command, "/bin/sh")
		assert.deepEqual(entry.args, ["-c", 'cd "$HOME" && exec npx "$@"', "npx", "-y", "health-code@1.2.3", "mcp"])
	}

	// rotate the secret in place and isolate registrations for other origins
	await setupAccount({ ...environment, ANTHROPIC_API_KEY: `${key}-rotated` }, setup)
	assert.equal(stored[0], stored[1])
	await setupAccount(
		{
			...environment,
			HEALTH_CODE_MODEL_HOST: "https://models.example.com",
			HEALTH_CODE_INPUT_USD_PER_MILLION: "3",
			HEALTH_CODE_OUTPUT_USD_PER_MILLION: "16",
		},
		setup,
	)
	assert.notEqual(stored[1], stored[2])
	await setupAccount({ RUNTA_TOKEN: environment.RUNTA_TOKEN }, setup)
	assert.equal(stored.length, 3)

	// reject missing and unresolved credentials
	await assert.rejects(setupAccount({}, setup), /Supply RUNTA_TOKEN/)
	await assert.rejects(
		setupAccount({ ...environment, ANTHROPIC_API_KEY: `\${ANTHROPIC_API_KEY}` }, setup),
		/ANTHROPIC_API_KEY/,
	)

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
