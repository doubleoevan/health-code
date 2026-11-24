import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { createFakeSandboxProvider, inspectRepository, type SandboxFixture } from "health-code"
import { selectedOutput, toSelectedResult, UpgradeMenus, upgradeMenuOutput } from "./browseUpgrades.ts"
import { createServer } from "./createServer.ts"
import { fetchPatch, validateOutcome } from "./fetchPatch.ts"
import { environment, inspectionFixtureUrl, key, repo } from "./fixtures/inspectionSettings.ts"
import { InspectionStore, protect, type SavedReport, toHash } from "./storeInspection.ts"
import { Inspections } from "./trackInspections.ts"

// Supply upstream feature evidence without leaving the fixture.
const releaseRequest: typeof fetch = async (url): Promise<Response> => {
	const notes = ["v1.1.0", "v1.3.0"].map((tag_name) => ({
		tag_name,
		body: "## Features\n- Shared defaults",
		draft: false,
		prerelease: false,
	}))
	if (String(url).endsWith("/graphql")) {
		return Response.json({
			data: {
				repository: {
					visibility: "PUBLIC",
					releases: { nodes: notes, pageInfo: { hasNextPage: false, endCursor: null } },
				},
			},
		})
	}
	return Response.json(
		String(url).includes("registry.npmjs.org") ? { repository: "https://github.com/example/gadget" } : notes,
	)
}

test("replay delivers exact Patch pages and durable application results", async () => {
	const root = await mkdtemp(join(tmpdir(), "mcp-patches-"))
	const store = new InspectionStore(root, protect(environment))
	const inspectionId = randomUUID()

	// use a multibyte patch to exercise text pagination
	const mailbox = `first line\n${"x".repeat(4095)}🟢\n`
	const sha256 = toHash(mailbox)
	const patch = {
		digest: sha256,
		mailbox,
		role: "upgrade",
		id: "upgrade",
		filename: "upgrade.patch",
		base: "a".repeat(40),
		testedTip: "b".repeat(40),
		prompt: "Verify this Patch.",
		commits: [],
	}

	// make the feature patch depend on the tested upgrade tip
	const feature = {
		...patch,
		role: "feature",
		prerequisite: "upgrade",
		id: "feature",
		base: "b".repeat(40),
		mailbox: "adopt feature\n",
		digest: toHash("adopt feature\n"),
	}

	// Give a second dependency its own mailbox on the same inspected commit.
	const otherMailbox = "upgrade gadget\n"
	const other = { ...patch, mailbox: otherMailbox, digest: toHash(otherMailbox) }
	const report: SavedReport = {
		version: 2,
		inspectionId,
		repository: { url: repo, commit: "a".repeat(40) },
		selection: {
			eligible: [
				{ dependency: "widget", kind: "major", from: { ".": "1.0.0" }, to: "2.0.0" },
				{ dependency: "gadget", kind: "minor", from: { ".": "1.0.0" }, to: "1.1.0" },
			],
		},
		baseline: {},
		timeline: [],
		upgrades: [
			{ dependency: "widget", to: "2.0.0", verdict: "Fixed", patches: [patch, feature] },
			{ dependency: "gadget", to: "1.1.0", verdict: "Passes as is", patches: [other] },
		],
	}
	try {
		// reconstruct the saved mailbox and verify its digest
		await store.save(report)
		const saved = await store.load(inspectionId)
		const reader = new Inspections(store, async () => {
			throw new Error("Unexpected inspection")
		})
		const { patches } = await reader.read({ inspectionId, reportOffset: 0, afterSequence: 0, waitMs: 0 })
		assert.deepEqual(
			patches.map((patch) => [patch.dependency, patch.to, patch.role, patch.sha256, patch.prerequisiteSha256]),
			[
				["widget", "2.0.0", "upgrade", sha256, null],
				["widget", "2.0.0", "feature", feature.digest, sha256],
				["gadget", "1.1.0", "upgrade", other.digest, null],
			],
		)

		// Fetch each selected artifact independently after reopening the report.
		const upgradeMenus = new UpgradeMenus(store, releaseRequest)
		const upgradeMenu = await upgradeMenus.list({
			upgradeMenuId: inspectionId,
			order: "minor",
			search: "gad",
			readyOnly: true,
			offset: 0,
		})
		assert.deepEqual(
			upgradeMenu.dependencies.map((group) => group.dependency),
			["gadget"],
		)

		// Reopen the upgrade menu with the same GitHub repository under another capitalization.
		const upgradeMenuId = randomUUID()
		await store.save({
			...report,
			inspectionId: upgradeMenuId,
			repository: { ...report.repository, url: "https://github.com/Example/Project" },
			upgrades: [],
		})

		// Keep the release and patch evidence on the same inspected commit.
		const choice = { upgradeMenuId, dependency: "gadget", to: "1.1.0" }
		const preview = await upgradeMenus.features(choice)
		assert.equal(preview.features[0]?.text, "Shared defaults")
		assert.deepEqual(upgradeMenu.dependencies[0]?.targets[0]?.releaseFeatures.features, preview.features)
		await assert.rejects(upgradeMenus.features({ ...choice, to: "3.0.0" }))

		// Fetch the chosen patch independently of its release preview.
		const selected = await upgradeMenus.select(repo.toUpperCase(), choice)
		assert.deepEqual(selected.patch, { inspectionId, sha256: other.digest })
		await assert.rejects(upgradeMenus.select(repo, { upgradeMenuId: inspectionId, dependency: "gadget", to: "2.0.0" }))

		// Verify that retrieval returns only the selected dependency's bytes.
		const gadget = fetchPatch(saved, { sha256: other.digest, offset: 0 })
		assert.deepEqual(toSelectedResult(saved, choice).patch, gadget)
		assert.equal(gadget.text, otherMailbox)
		assert.equal(gadget.base, report.repository.commit)
		assert.equal(gadget.prerequisiteSha256, null)
		const first = fetchPatch(saved, { sha256, offset: 0 })
		const rest = fetchPatch(saved, { sha256, offset: first.nextOffset ?? 0 })
		assert.equal(toHash(first.text + rest.text), sha256)

		// preserve each reported checkout relationship on the patch handoff
		for (const relationship of ["equal", "ahead", "behind", "diverged", "unknown"] as const) {
			const result = fetchPatch(saved, { sha256: feature.digest, offset: 0, checkout: { relationship, dirty: true } })
			assert.equal(result.checkout.relationship, relationship)
			assert.equal(result.prerequisiteSha256, sha256)
		}
		const outcome = {
			inspectionId,
			sha256,
			application: "adapted" as const,
			adaptation: "Adjusted an import",
			tests: "passed" as const,
			pullRequest: `${repo}/pull/1`,
		}

		// reject invalid adaptations, pull requests and patch identities
		assert.throws(() => validateOutcome(saved, { ...outcome, adaptation: "" }))
		assert.throws(() => validateOutcome(saved, { ...outcome, pullRequest: "https://example.org" }))
		assert.throws(() => validateOutcome(saved, { ...outcome, sha256: "c".repeat(64) }))
		validateOutcome(saved, outcome)

		// deduplicate identical results while retaining different test outcomes
		await Promise.all([store.record(outcome), store.record(outcome), store.record({ ...outcome, tests: "failed" })])
		assert.equal((await new InspectionStore(root).outcomes(inspectionId)).length, 2)
		await assert.rejects(store.record({ ...outcome, adaptation: key }))

		// reject changed bytes under a previously verified digest
		assert.throws(() =>
			fetchPatch(
				{ ...report, upgrades: [{ dependency: "widget", patches: [{ ...patch, mailbox: "altered" }] }] },
				{ sha256, offset: 0 },
			),
		)

		// stop the handoff for commits that edit tests
		assert.match(
			fetchPatch(
				{
					...report,
					upgrades: [
						{
							dependency: "widget",
							verdict: "Fixed with test changes",
							patches: [{ ...patch, commits: [{ subject: "Edit tests", sha: "c".repeat(40), flag: "test" }] }],
						},
					],
				},
				{ sha256, offset: 0 },
			).action,
			/Stop/,
		)

		// reject credentials and corrupt report data on disk
		await assert.rejects(store.save({ ...report, inspectionId: randomUUID(), exposed: key }))
		await writeFile(join(root, inspectionId, "inspection-report.json"), "partial")
		await assert.rejects(store.load(inspectionId), /unreadable/)
		await assert.rejects(store.load("../escape"))

		// reject linked records and ignore unfinished writes
		const linked = randomUUID()
		await symlink(join(root, inspectionId), join(root, linked))
		await assert.rejects(store.load(linked), /unreadable/)

		// confirm that pending records never appear under a finished id
		await mkdir(join(root, ".pending-example"))
		assert.deepEqual(new Set(await store.reportIds()), new Set([inspectionId, upgradeMenuId]))
		await assert.rejects(store.load(randomUUID()), /not found/)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test("the MCP lists choices and starts only the selected target", async () => {
	const root = await mkdtemp(join(tmpdir(), "mcp-upgrade-menu-"))
	const store = new InspectionStore(root, protect(environment))
	const fixture: SandboxFixture = JSON.parse(await readFile(inspectionFixtureUrl, "utf8"))

	// Give each job its own sandbox at the recorded commit.
	const created = Promise.withResolvers<void>()
	let checkoutReleased = false
	const inspections = new Inspections(store, (options) => {
		const commands = options.upgrade
			? fixture.commands.filter((command) => command.argv[2] !== "registry")
			: fixture.commands
		const sandboxProvider = createFakeSandboxProvider({ ...fixture, commands })

		// Hold the selected checkout until the client receives a live creation event.
		if (options.upgrade) {
			const prepare = sandboxProvider.prepareRepository
			sandboxProvider.prepareRepository = async (...args) => {
				const timer = setTimeout(created.resolve, 2000)
				await created.promise
				clearTimeout(timer)

				checkoutReleased = true
				return prepare(...args)
			}
		}

		return inspectRepository({ ...options, sandboxProvider })
	})

	// Follow the agent's ordinary tool calls through the MCP transport.
	const client = new Client({ name: "upgrade-menu-test", version: "1" })
	const server = createServer({ inspections, version: "1", upgradeMenus: new UpgradeMenus(store, releaseRequest) })
	const [left, right] = InMemoryTransport.createLinkedPair()

	// Complete both user-facing operations through the tool interface.
	try {
		await Promise.all([server.connect(left), client.connect(right)])
		const list = await client.callTool({
			name: "list_upgrades",
			arguments: { repositoryUrl: repo, order: "alphabetical", search: "widget" },
		})
		assert.ok(!list.isError)
		const { upgradeMenuId, dependencies } = upgradeMenuOutput.parse(list.structuredContent)

		// Reuse the returned key for paging and recognize the earlier pagination argument.
		for (const identity of [{ upgradeMenuId }, { inspectionId: upgradeMenuId }]) {
			const page = await client.callTool({ name: "list_upgrades", arguments: { ...identity, order: "workspaces" } })
			assert.ok(!page.isError)
			assert.equal(upgradeMenuOutput.parse(page.structuredContent).upgradeMenuId, upgradeMenuId)
		}
		const target = dependencies[0]?.targets[0]
		assert.ok(target)
		assert.equal(target.releaseFeatures.features[0]?.text, "Shared defaults")

		// Fetch a result for just this upgrade menu choice.
		const progress: string[] = []
		let sawLiveCreation = false
		const tested = await client.callTool(
			{
				name: "get_upgrade",
				arguments: { upgradeMenuId, dependency: target.dependency, to: target.to },
			},
			{
				onprogress: (update) => {
					progress.push(String(update.message))
					if (String(update.message).includes("Runta · created")) {
						sawLiveCreation = !checkoutReleased
						created.resolve()
					}
				},
			},
		)
		assert.ok(!tested.isError)
		const { inspectionId: id, patch, reason } = selectedOutput.parse(tested.structuredContent)
		assert.ok(patch || reason)
		assert.ok(sawLiveCreation)
		assert.ok(progress.some((line) => line.includes("Runta · deleted")))
		assert.ok(progress.at(-1)?.endsWith("Inspection finished"))

		// Check the durable report for the selected version and original upgrade menu commit.
		const report = await store.load(id)
		assert.equal(report.repository.commit, (await store.load(upgradeMenuId)).repository.commit)
		assert.deepEqual(
			report.upgrades.map((upgrade) => [upgrade.dependency, upgrade.to]),
			[[target.dependency, target.to]],
		)
	} finally {
		await inspections.close()
		await client.close()
		await server.close()
		await rm(root, { recursive: true, force: true })
	}
})
