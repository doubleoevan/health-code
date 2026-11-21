import assert from "node:assert/strict"
import { test } from "node:test"
import { readReleases } from "../src/readReleases.ts"

test("a public dependency cannot publish release text from a private upstream", async () => {
	const paths: string[] = []
	const result = await readReleases({
		upgrade: { dependency: "widget", kind: "minor", from: { ".": "1.0.0" }, to: "1.1.0" },
		githubToken: "fixture",
		changelog: "",
		request: async (input): Promise<Response> => {
			const url = new URL(String(input))
			paths.push(url.pathname)
			if (url.hostname === "registry.npmjs.org") {
				return Response.json({ repository: "github:example/private" })
			}
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
	assert.deepEqual(paths, ["/widget/1.1.0", "/graphql"])
	assert.deepEqual(result.notes, [])
})

test("oversized release metadata cancels the body and keeps the package changelog", async () => {
	let cancelled = false
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
	assert.equal(cancelled, true)
	assert.equal(notes.length, 1)
	assert.match(notes[0]?.text ?? "", /New option/)
	assert.ok(gaps.length > 0)
})
