import assert from "node:assert/strict"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { createFakeSandboxProvider } from "health-code"
import { checkRepository, readCheckArguments } from "./checkRepository.ts"
import { modelSettings } from "./fixtures/inspectionSettings.ts"
import { modelRequestSandboxFixture } from "./fixtures/modelRequestSandboxInspection.ts"

const repositoryUrl = "https://github.com/example/project"
test("check arguments require a complete target and keep equals signs in test values", () => {
	const parsed = readCheckArguments([repositoryUrl, "--env", "URL=a=b", "--env", "BUDGET=1"])
	assert.deepEqual(parsed.applicationEnvironment, { URL: "a=b", BUDGET: "1" })
	assert.equal(readCheckArguments([repositoryUrl]).applicationEnvironment, undefined)

	// reject missing, partial and unknown arguments
	for (const args of [[], [repositoryUrl, "--to", "2.0.0"], [repositoryUrl, "--env", "BUDGET"], ["--unknown"]]) {
		assert.throws(() => readCheckArguments(args), /Usage: health-code check/)
	}
})

test("check writes the report and its verified patch", async () => {
	const { provider, mailbox, restore } = await modelRequestSandboxFixture(createFakeSandboxProvider, "github-token")
	const output = await mkdtemp(join(tmpdir(), "health-code-check-"))
	const lines: string[] = []
	try {
		// leave a patch from an earlier check beside an unrelated one
		const earlier = { upgrades: [{ patches: [{ filename: "earlier.patch" }, { filename: "../escape.patch" }] }] }
		await writeFile(join(output, "inspection-report.json"), JSON.stringify(earlier))
		await writeFile(join(output, "earlier.patch"), "old")
		await writeFile(join(output, "kept.txt"), "kept")

		// run the same paid entry point a CI job uses
		const result = await checkRepository([repositoryUrl, "--output", output], {
			environment: { ...modelSettings, RUNTA_TOKEN: "runta-token", GITHUB_TOKEN: "github-token" },
			signal: new AbortController().signal,
			sandboxProvider: provider,
			log: (line) => lines.push(line),
		})
		assert.equal(result.isComplete, true)

		// compare the saved patch with the verified bytes
		const files = await readdir(output)
		const patch = files.find((file) => file.endsWith(".patch"))
		assert.ok(patch && files.includes("inspection-report.json"))
		assert.ok(files.includes("kept.txt") && !files.includes("earlier.patch"))
		assert.equal(await readFile(join(output, patch), "utf8"), mailbox)

		// report the number of saved patches
		assert.ok(lines.some((line) => line.endsWith("1 patch")))
	} finally {
		restore()
		await rm(output, { recursive: true, force: true })
	}
})
