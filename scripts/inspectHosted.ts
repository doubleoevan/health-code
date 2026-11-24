import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { chromium, type Locator, type Page } from "playwright"
import { z } from "zod"

const repositories = [
	"doubleoevan/carlnotes",
	"changesets/changesets",
	"sindresorhus/ky",
	"vercel/nextjs-postgres-nextauth-tailwindcss-template",
]

// Persist public evidence from each completed browser case.
type Evidence = {
	id: string
	commit: string
	url: string
	reused: boolean
	verdicts: string[]
	promptVersions: NonNullable<Snapshot["card"]["promptVersions"]>
}

// Read only the report fields needed by the acceptance checks.
type Snapshot = {
	id: string
	state: string
	events: { type: string; action?: string; sandboxId?: string; inspectionId: string }[]

	// Inspect the published fields that a signed-out reviewer can see.
	card: {
		repository: { url: string; commit: string }
		upgrades: { verdict?: string; reason?: string; untestedReason?: string }[]
		promptVersions?: { model: { name: string; version: number; sha256: string }[] }
	}
}

async function submit(
	page: Page,
	repository: string,
): Promise<{ path: string; reused: boolean; upgradeMenuPath: string }> {
	await page.getByLabel("Public GitHub repository").fill(`https://github.com/${repository}`)
	const upgradeMenu = await admit(page, page.getByRole("button", { name: "New features" }))
	await page.waitForURL((url) => url.pathname === upgradeMenu.path)
	await page.getByRole("heading", { name: "Try an upgrade" }).waitFor({ timeout: 2400000 })

	// Select the first displayed target through the same controls as a visitor.
	const group = page
		.locator("article")
		.filter({
			has: page.getByRole("button", { name: "Try upgrade" }).or(page.getByRole("link", { name: "See patch" })),
		})
		.first()

	const target = group.locator("li").first()
	const ready = target.getByRole("link", { name: "See patch" })

	// Follow the existing patch directly when its report is already available.
	if (await ready.count()) {
		const link = await ready.getAttribute("href")
		assert.ok(link)
		await ready.click()
		return { path: new URL(link, page.url()).pathname, reused: true, upgradeMenuPath: upgradeMenu.path }
	}
	return {
		...(await admit(page, target.getByRole("button", { name: "Try upgrade" }))),
		upgradeMenuPath: upgradeMenu.path,
	}
}

async function admit(page: Page, button: Locator): Promise<{ path: string; reused: boolean }> {
	const response = page.waitForResponse(
		(item) => new URL(item.url()).pathname === "/api/inspections" && item.request().method() === "POST",
	)
	await button.click()
	let admission = await response

	// Complete the real widget on the configured host and submit through the ordinary form.
	if (admission.status() === 403 && (await admission.json()).siteKey) {
		console.log("Waiting for verification in the opened browser. Complete the widget if prompted.")
		admission = await page.waitForResponse(
			(item) => new URL(item.url()).pathname === "/api/inspections" && item.request().method() === "POST",
			{ timeout: 180000 },
		)
	}
	assert.ok(
		[200, 202].includes(admission.status()),
		`Admission stopped with HTTP ${admission.status()}. Check the site's cap or verification message.`,
	)
	const path = admission.headers().location
	assert.ok(path)
	assert.match(path, /^\/r\/[A-Za-z0-9_-]+$/)
	return { path, reused: admission.status() === 200 }
}

async function verifyCleanup(options: { inspectionId: string; deployment: string; token: string }): Promise<void> {
	const url = new URL("https://api.runta.com/v2/runtimes")
	url.searchParams.set("limit", "100")
	const seen = new Set<string>()
	const name = `hc-site-${options.deployment}-${options.inspectionId}`

	// Page the provider's inventory independently of the site's recorded teardown event.
	for (;;) {
		const response = await fetch(url, {
			headers: { Authorization: `Bearer ${options.token}` },
			redirect: "error",
			signal: AbortSignal.timeout(15000),
		})
		assert.ok(response.ok, "Runta inventory unavailable")
		const inventory = z
			.object({
				data: z.array(z.object({ display_name: z.string() })),
				pagination: z.object({ has_more: z.boolean(), next_cursor: z.string().nullable() }),
			})
			.parse(await response.json())
		assert.ok(
			inventory.data.every(
				(runtime: { display_name: string }) =>
					runtime.display_name !== name && runtime.display_name !== `${name}-relay`,
			),
			"Allocation still present after inspection",
		)
		if (inventory.pagination.has_more === false) {
			return
		}

		// Require inventory pagination to advance.
		const cursor = inventory.pagination.next_cursor
		assert.ok(typeof cursor === "string" && cursor && !seen.has(cursor))
		seen.add(cursor)
		url.searchParams.set("after", cursor)
	}
}

async function verifyHistoryCleanup(
	events: Snapshot["events"],
	options: { deployment: string; token: string },
): Promise<void> {
	// Pair each lifetime with a later deletion even when a replacement reuses its name.
	const live = new Set<string>()
	let inspectionId: string | undefined
	for (const event of events) {
		if (event.type !== "sandbox.event" || !event.sandboxId) {
			continue
		}

		// Record each creation before accepting its matching deletion.
		if (event.action === "created") {
			assert.ok(!live.has(event.sandboxId), "Sandbox name reused before deletion")
			live.add(event.sandboxId)
			inspectionId = event.inspectionId
		} else if (event.action === "deleted") {
			live.delete(event.sandboxId)
		}
	}

	assert.ok(inspectionId, "Missing sandbox creation")
	assert.equal(live.size, 0, "Missing sandbox deletion")
	await verifyCleanup({ ...options, inspectionId })
}

async function inspect(
	page: Page,
	options: { origin: string; repository: string; deployment: string; token: string },
): Promise<Evidence> {
	await page.goto(options.origin)
	const { path, reused, upgradeMenuPath } = await submit(page, options.repository)
	await page.waitForURL((url) => url.origin === options.origin && url.pathname === path)

	// Wait for terminal SSR and retain rendered verdict coverage only.
	await page
		.getByRole("heading", { level: 1, name: /Inspection complete|not tested|Inspection failed|Inspection interrupted/ })
		.waitFor({ timeout: 2400000 })
	const snapshot: Snapshot = JSON.parse((await page.locator("#page-state").textContent()) ?? "{}").snapshot
	assert.equal(snapshot.state, "complete")

	// Verify the commit and provenance shown to a signed-out reader.
	assert.equal(snapshot.card.repository.url, `https://github.com/${options.repository}`)
	assert.match(snapshot.card.repository.commit, /^[a-f0-9]{40}$/)
	const versions = snapshot.card.promptVersions
	assert.ok(versions && Array.isArray(versions.model), "Missing prompt provenance")

	// Inspect visible explanations alongside their published reports.
	const text = await page.locator("main").innerText()
	const verdicts: string[] = []
	for (const upgrade of snapshot.card.upgrades) {
		const { verdict } = upgrade
		assert.ok(verdict && text.includes(verdict), "Verdict missing from rendered report")
		verdicts.push(verdict)

		// Require the actual diagnostic for an inconclusive or unsuccessful upgrade.
		if (verdict === "Untested" || verdict === "Can't fix") {
			const reason = verdict === "Untested" ? upgrade.untestedReason : upgrade.reason
			assert.ok(reason && text.includes(reason), "Verdict explanation missing from rendered report")
		}
	}

	// Check each dispatched version in the published report.
	for (const ref of versions.model) {
		assert.match(ref.sha256, /^[a-f0-9]{64}$/)
	}

	// Verify teardown for both discovery and the selected upgrade, including replacement runtimes.
	const upgradeMenuId = upgradeMenuPath.split("/").at(-1)
	const response = await page.request.get(`${options.origin}/api/inspections/${upgradeMenuId}/events`)
	assert.ok(response.ok())
	const frames = (await response.text()).split("\n\n")
	const events: Snapshot["events"] = frames
		.filter((frame) => frame.includes("event: inspection\n"))
		.map((frame) => JSON.parse(frame.split("data: ")[1]!))

	await verifyHistoryCleanup(events, options)
	await verifyHistoryCleanup(snapshot.events, options)
	return {
		id: snapshot.id,
		url: options.origin + path,
		commit: snapshot.card.repository.commit,
		reused,
		verdicts,
		promptVersions: versions,
	}
}

async function main(): Promise<void> {
	const origin = new URL(process.env.HEALTH_CODE_ORIGIN ?? "https://runhealthcode.dev").origin
	const deployment = process.env.HEALTH_CODE_DEPLOYMENT
	const token = process.env.RUNTA_TOKEN
	assert.ok(
		origin.startsWith("https://") && deployment && token,
		"Set HTTPS origin, deployment namespace and Runta inventory credentials",
	)
	const folder = join("logs", "hosted", new Date().toISOString().replaceAll(":", "-"))
	await mkdir(folder, { recursive: true })
	const browser = await chromium.launch({ headless: false })
	try {
		// Keep one signed-out visitor and respect the deployment's daily admission limit.
		const page = await browser.newPage()
		for (const repository of repositories) {
			const evidence = await inspect(page, { origin, repository, deployment, token })
			await writeFile(join(folder, `${repository.replace("/", "-")}.json`), JSON.stringify(evidence, null, 2))
			if (repository === repositories[0]) {
				await page.goto(origin)
				const cached = await submit(page, repository)
				assert.ok(
					cached.reused && origin + cached.path === evidence.url,
					"Identical repository did not return the saved report",
				)
			}
			console.log(repository, evidence.url, evidence.commit, evidence.verdicts)
		}
	} finally {
		// Release the headed browser after the last verified case.
		await browser.close()
	}
}
await main()
