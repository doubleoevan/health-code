import assert from "node:assert/strict"
import { test } from "node:test"
import { readPackageFileDigests } from "health-code"
import {
	describeOversizedExecutable,
	findEmbeddedFileDifferences,
	maxEmbeddedBytes,
	toPlatformName,
} from "./checkExecutable.ts"

test("the build names each missing, extra and changed package file", () => {
	const digests = readPackageFileDigests()
	const reportedFiles = Object.fromEntries(digests.map(({ path, sha256 }) => [path, sha256]))
	assert.deepEqual(findEmbeddedFileDifferences(digests, reportedFiles), [])

	// drop one prompt, change one Guest bundle and add an unlisted file
	delete reportedFiles["prompts/repair.md"]
	reportedFiles["dist/agent.mjs"] = "0".repeat(64)
	reportedFiles["prompts/AGENTS.md"] = "1".repeat(64)
	assert.deepEqual(findEmbeddedFileDifferences(digests, reportedFiles), [
		"missing prompts/repair.md",
		"different dist/agent.mjs",
		"extra prompts/AGENTS.md",
	])
})

test("the build rejects an executable that embeds more than the limit", () => {
	const runtimeBytes = 70 * 1024 * 1024
	assert.equal(describeOversizedExecutable(runtimeBytes + maxEmbeddedBytes, runtimeBytes), undefined)
	assert.equal(
		describeOversizedExecutable(runtimeBytes + 20 * 1024 * 1024, runtimeBytes),
		"The executable adds 20.0 MB to the Bun runtime. The limit is 15 MB.",
	)
})

test("only the three release platforms have a name", () => {
	assert.equal(toPlatformName("linux", "x64"), "linux-x64")
	assert.equal(toPlatformName("linux", "arm64"), "linux-arm64")
	assert.equal(toPlatformName("darwin", "arm64"), "darwin-arm64")
	assert.equal(toPlatformName("darwin", "x64"), undefined)
	assert.equal(toPlatformName("win32", "x64"), undefined)
})
