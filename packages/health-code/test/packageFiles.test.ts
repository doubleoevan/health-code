import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { InspectionError, readPackageFileDigests } from "../src/index.ts"
import { type PackageFile, packageFiles, readPackageFile } from "../src/readPackageFile.ts"

const packageRoot = new URL("../", import.meta.url)

test("the package file list names every prompt template and Guest bundle the package builds", () => {
	const listedPrompts = packageFiles.filter((path) => path.startsWith("prompts/")).sort()
	const listedBundles = packageFiles.filter((path) => path.startsWith("dist/")).sort()

	// compare with the templates on disk, leaving out the folder guide
	const promptFiles = readdirSync(new URL("prompts/", packageRoot)).filter((name) => name !== "AGENTS.md")
	assert.deepEqual(listedPrompts, promptFiles.map((name) => `prompts/${name}`).sort())

	// compare with the Guest bundles the build script writes
	const { scripts } = JSON.parse(readFileSync(new URL("package.json", packageRoot), "utf8")) as {
		scripts: { build: string }
	}
	const builtBundles = [...scripts.build.matchAll(/--outfile=(dist\/[^\s&]+)/g)].map((match) => match[1])
	assert.deepEqual(listedBundles, builtBundles.sort())
	assert.ok(packageFiles.includes("package.json"))
})

test("every package file reads from the workspace", () => {
	for (const path of packageFiles) {
		assert.deepEqual(readPackageFile(path), readFileSync(new URL(path, packageRoot)), path)
	}
})

test("package file digests match the files on disk", () => {
	const digests = readPackageFileDigests()
	assert.deepEqual(
		digests.map(({ path }) => path),
		[...packageFiles],
	)

	// hash each file independently of the reader
	for (const { path, sha256 } of digests) {
		const expected = createHash("sha256")
			.update(readFileSync(new URL(path, packageRoot)))
			.digest("hex")
		assert.equal(sha256, expected, path)
	}
})

test("no Guest bundle holds the build machine's path, so every platform builds the same bytes", () => {
	const workspaceRoot = fileURLToPath(new URL("../../", packageRoot))
	for (const path of packageFiles.filter((name) => name.startsWith("dist/"))) {
		assert.equal(readPackageFile(path).includes(workspaceRoot), false, path)
	}
})

test("a missing Guest bundle or an invalid template names the file", () => {
	const copy = mkdtempSync(join(tmpdir(), "health-code-package-"))
	try {
		// copy the package files and read from the copy
		for (const path of packageFiles) {
			cpSync(new URL(path, packageRoot), join(copy, path), { recursive: true })
		}
		const readCopy = (path: PackageFile): Buffer => readFileSync(join(copy, path))
		assert.equal(readPackageFileDigests(readCopy).length, packageFiles.length)

		// add a placeholder the repair template does not allow
		const repairPath = join(copy, "prompts/repair.md")
		writeFileSync(repairPath, `${readFileSync(repairPath, "utf8")}\n{{other}}\n`)
		assert.throws(() => readPackageFileDigests(readCopy), packageFilesError("invalid prompts/repair.md"))

		// remove one Guest bundle after restoring the template
		cpSync(new URL("prompts/repair.md", packageRoot), repairPath)
		rmSync(join(copy, "dist/agent.mjs"))
		assert.throws(() => readPackageFileDigests(readCopy), packageFilesError("missing dist/agent.mjs"))
	} finally {
		rmSync(copy, { recursive: true, force: true })
	}
})

// match the package files error that names one file
function packageFilesError(phrase: string): (error: unknown) => boolean {
	return (error) => error instanceof InspectionError && error.code === "package-files" && error.message.includes(phrase)
}
