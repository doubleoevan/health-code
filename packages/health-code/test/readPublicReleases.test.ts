import assert from "node:assert/strict"
import { test } from "node:test"
import { readReleases } from "../src/readReleases.ts"
import { readUpgradeFeatures } from "../src/readUpgradeFeatures.ts"

test("a public dependency cannot publish release text from a private upstream", async () => {
	const paths: string[] = []
	const result = await readReleases({
		upgrade: { dependency: "widget", kind: "minor", from: { ".": "1.0.0" }, to: "1.1.0" },
		githubToken: "fixture",
		changelog: "",
		request: async (input): Promise<Response> => {
			const url = new URL(String(input))
			paths.push(url.pathname)

			// resolve the public package to its private upstream
			if (url.hostname === "registry.npmjs.org") {
				return Response.json({ repository: "github:example/private" })
			}

			// return a release body alongside the private visibility marker
			assert.equal(url.pathname, "/graphql")
			return Response.json({
				data: {
					repository: {
						visibility: "PRIVATE",
						releases: {
							nodes: [{ tag_name: "1.1.0", body: "Private note", draft: false, prerelease: false }],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				},
			})
		},
	})

	// verify that the lookup stops without exposing release notes
	assert.deepEqual(paths, ["/widget/1.1.0", "/graphql"])
	assert.deepEqual(result.notes, [])
})

test("oversized release metadata cancels the body and keeps the package changelog", async () => {
	let cancelled = false

	// deliver an unbounded stream in fixed-size chunks
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			controller.enqueue(new Uint8Array(1024 * 1024))
		},
		cancel() {
			cancelled = true
		},
	})
	const { notes, gaps } = await readReleases({
		upgrade: { dependency: "widget", kind: "minor", from: { ".": "1.0.0" }, to: "1.1.0" },
		changelog: "## [1.1.0]\n### Node 18 support\nNew option",
		request: async () => new Response(body),
	})

	// verify cancellation and retain the fallback changelog evidence
	assert.equal(cancelled, true)
	assert.equal(notes.length, 1)
	assert.match(notes[0]?.text ?? "", /New option/)
	assert.ok(gaps.length > 0)
})

test("feature previews cite only documented additions crossed by each workspace", async () => {
	const upgrade = { dependency: "widget", kind: "minor" as const, from: { ".": "1.1.0", child: "1.0.0" }, to: "1.2.0" }
	const body =
		"### Features\n#### Configuration\n- Adds the `defaults` option.\n**Bug Fixes**\n- Correct a typo\n```js\n```text\nfeat: example only\n```"
	const releases = ["1.3.0", "1.2.0", "1.1.0", "1.0.0"].map((version) => ({
		tag_name: `widget@${version}`,
		draft: false,
		prerelease: false,
		body: version === "1.1.0" ? "* feat: Share a configuration." : body,
	}))

	// Supply registry coordinates and upstream releases without contacting a service.
	const result = await readUpgradeFeatures(upgrade, {
		request: async (input) =>
			Response.json(
				String(input).startsWith("https://registry.npmjs.org/") ? { repository: "github:example/widget" } : releases,
			),
	})
	assert.deepEqual(
		result.features.map((item) => [item.text, item.workspaces]),
		[
			["Adds the defaults option.", [".", "child"]],
			["Share a configuration.", ["child"]],
		],
	)
	assert.equal(result.features[0]?.source, "https://github.com/example/widget/releases/tag/widget%401.2.0")

	// Distinguish a release with only fixes from an unavailable source.
	releases.forEach((release) => {
		release.body = "### Bug fixes\n- Fix timeout"
	})
	const fixes = await readUpgradeFeatures(upgrade, {
		request: async (input) =>
			Response.json(String(input).includes("registry.npmjs.org") ? { repository: "github:example/widget" } : releases),
	})
	assert.deepEqual(fixes.features, [])
	assert.equal(fixes.sources.length, 2)
	const unavailable = await readUpgradeFeatures(upgrade, { request: async () => new Response(null, { status: 503 }) })
	assert.ok(unavailable.gaps.length && !unavailable.sources.length)
})

test("the library returns feature entries beyond the first web page with their release citations", async () => {
	const additions = Array.from({ length: 7 }, (_, index) => `Adds option ${index + 1}.`)
	const upgrade = { dependency: "widget", from: { ".": "1.0.0" }, to: "1.2.0", kind: "minor" as const }
	const release = (
		tag_name: string,
		entries: string[],
	): { tag_name: string; body: string; draft: boolean; prerelease: boolean } => ({
		tag_name,
		body: ["## Features", ...entries.map((entry) => `- ${entry}`)].join("\n"),
		draft: false,
		prerelease: false,
	})

	// Cross a page boundary within one release, then include the next matching release.
	const releases = [release("v1.2.0", additions.slice(0, 6)), release("v1.1.0", additions.slice(6))]
	const result = await readUpgradeFeatures(upgrade, {
		request: async (input) =>
			Response.json(
				String(input).startsWith("https://registry.npmjs.org/") ? { repository: "github:example/widget" } : releases,
			),
	})
	assert.deepEqual(
		result.features.map((feature) => feature.text),
		additions,
	)
	assert.equal(result.features.at(-1)?.source, "https://github.com/example/widget/releases/tag/v1.1.0")
})

test("a release note cut at its limit keeps only whole lines", async () => {
	const line = "- [290c594](https://github.com/example/widget/commit/290c594) feat: add an option"
	const { notes } = await readReleases({
		upgrade: { dependency: "widget", kind: "minor", from: { ".": "1.0.0" }, to: "1.1.0" },
		changelog: "## 1.1.0\n" + Array.from({ length: 80 }, () => line).join("\n"),
		request: async () => new Response(null, { status: 503 }),
	})

	// end the note on a complete entry
	const text = notes[0]?.text ?? ""
	assert.ok(text.length > 3900 && text.length <= 4000)
	assert.ok(text.endsWith(line))
})
