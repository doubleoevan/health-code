import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { readProjectFile, writeProjectFile } from "../src/sandbox/projectFiles.ts"
import type { Runtime } from "../src/sandbox/requestRuntime.ts"

test("guest project files allow internal links and protect files outside the project", {
	skip: process.platform !== "linux",
}, async () => {
	const folder = await mkdtemp(join(tmpdir(), "project-files-"))
	const root = join(folder, "project")
	const operation = { timeoutMs: 1000 }
	const runtime = {
		async exec(
			argv: string[],
			input: { stdin?: string },
		): Promise<{ exitCode: number | null; stdoutText: string; stderrText: string; durationMs: number }> {
			const [script, , mode, target] = argv.slice(-4)
			assert.ok(script && mode && target)

			// Run the provider's Python program with this fixture as its project mount.
			const outcome = spawnSync(
				"python3",
				["-I", "-c", script, root, mode, join(root, target.slice("/project/".length))],
				{ encoding: "utf8", input: input.stdin },
			)
			return { exitCode: outcome.status, stdoutText: outcome.stdout, stderrText: outcome.stderr, durationMs: 0 }
		},
	} as unknown as Runtime
	try {
		await mkdir(root)
		await writeFile(join(folder, "other"), "private")
		await writeFile(join(root, "owned"), "original")

		// Both names stay usable when their descriptor resolves to a project file.
		await symlink("owned", join(root, "link"))
		await writeProjectFile({ runtime, path: "link", contents: "updated", operation })
		assert.equal(await readProjectFile({ runtime, path: "owned", operation }), "updated")

		// Confirm a refused write preserves the original file.
		await symlink("../other", join(root, "external"))
		await assert.rejects(readProjectFile({ runtime, path: "external", operation }))
		await assert.rejects(writeProjectFile({ runtime, path: "external", contents: "updated", operation }))
		assert.equal(await readFile(join(folder, "other"), "utf8"), "private")
	} finally {
		await rm(folder, { recursive: true, force: true })
	}
})
