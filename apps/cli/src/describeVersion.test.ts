import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { InspectionError, libraryVersion, readPackageFileDigests } from "health-code"
import { describeVersion, versionUsage } from "./describeVersion.ts"
import { toFailureMessage } from "./toFailureMessage.ts"

const cliPath = fileURLToPath(new URL("./cli.ts", import.meta.url))

test("the version names the release and the JSON form lists every package file digest", () => {
	assert.equal(describeVersion([]), `health-code ${libraryVersion}`)

	// compare the JSON form with the library's own digests
	const description = JSON.parse(describeVersion(["--json"]))
	const digests = readPackageFileDigests()
	assert.equal(description.version, libraryVersion)
	assert.match(description.runtime, /^bun \d+\.\d+\.\d+/)
	assert.deepEqual(description.files, Object.fromEntries(digests.map(({ path, sha256 }) => [path, sha256])))
	assert.equal(Object.keys(description.files).length, 13)
})

test("the version rejects other arguments and names a damaged package file", () => {
	assert.throws(() => describeVersion(["--json", "--json"]), { message: versionUsage })
	assert.throws(() => describeVersion(["--verbose"]), { message: versionUsage })

	// report the missing file the way the command prints it
	const missingFile = new InspectionError("package-files", "The health-code package is missing dist/agent.mjs.")
	const readDigests = (): never => {
		throw missingFile
	}
	assert.throws(() => describeVersion([], readDigests), missingFile)
	assert.match(toFailureMessage(missingFile), /missing dist\/agent\.mjs\. \(package-files\)$/)
})

test("the command prints the version without any setting", () => {
	const run = spawnSync(process.execPath, [cliPath, "--version"], { env: { PATH: process.env.PATH }, encoding: "utf8" })
	assert.equal(run.status, 0, run.stderr)
	assert.equal(run.stdout, `health-code ${libraryVersion}\n`)
	assert.equal(run.stderr, "")
})
