import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { managePatch } from "../guest/managePatch.ts"

test("upgrade and feature mailboxes replay at their exact parent trees", { timeout: 60000 }, () => {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "health-code-history-")))
	const source = join(root, "source"),
		work = join(root, "work")
	try {
		// create separate source and working directories
		mkdirSync(source)
		mkdirSync(work)
		const git = (args: string[]): string =>
			execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", source, ...args], {
				encoding: "utf8",
			}).trim()

		// seed a tracked tree with a protected test environment file
		git(["init", "-q"])
		writeFileSync(join(source, "package.json"), '{"version":"1"}\n')
		writeFileSync(join(source, "index.ts"), "export const one = 1\n")
		writeFileSync(join(source, ".env.test"), "TEST_SETTING=example\n")
		git(["add", "-f", "--", ".env.test"])
		git(["add", "."])
		git(["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture"])

		// capture the base and build descendants from explicitly selected files
		const base = git(["rev-parse", "HEAD"])
		const commit = (parent: string, file: string, contents: string, subject: string): string => {
			writeFileSync(join(work, file), contents)
			const result = managePatch(root, { kind: "commit", parent, files: [file], subject })
			assert.equal(typeof result, "string")
			return String(result)
		}

		// verify that exporting a legacy-encoded patch fails
		writeFileSync(join(work, "legacy.txt"), Buffer.from([0x61, 0xe9, 0x0a]))
		const legacy = managePatch(root, {
			kind: "commit",
			parent: base,
			files: ["legacy.txt"],
			subject: "Document legacy encoding",
		})
		assert.throws(() => managePatch(root, { kind: "export", base, tip: String(legacy) }), /encoded|encoding|UTF-8/i)

		// reconstruct the base and verify the protected file stays absent
		writeFileSync(join(work, "index.ts"), "export const one = 1\n")
		writeFileSync(join(work, "package.json"), '{"version":"1"}\n')
		assert.equal(managePatch(root, { kind: "verify", tip: base }), base)
		writeFileSync(join(work, ".env.test"), "changed")
		assert.throws(() => managePatch(root, { kind: "verify", tip: base }), /reappeared/)
		rmSync(join(work, ".env.test"))

		// define a new test that may be created only once
		const addTest = {
			kind: "edit" as const,
			file: "added.test.ts",
			contents: 'test("added", () => expect(read()).toBe(1))',
			createTest: true,
		}

		// reject duplicate creation and unsupported paths
		managePatch(root, addTest)
		assert.throws(() => managePatch(root, addTest), /EEXIST|exists/)
		assert.throws(() => managePatch(root, { ...addTest, file: "source.ts" }), /Unsupported new test path/)

		// build dependency, repair and feature commits in order
		const bump = commit(base, "package.json", '{"version":"2"}\n', "chore: bump dependency")
		const fix = commit(bump, "index.ts", "export const one = 2\n", "fix: support new behavior")
		const feature = commit(fix, "index.ts", "export const two = 2\n", "feat: adopt feature")
		const lateDependency = commit(
			fix,
			"package.json",
			'{"version":"2","dependencies":{"lib":"1.0.0"}}\n',
			"build: add replacement",
		)

		// require the tested worktree to match the selected tip
		assert.throws(() => managePatch(root, { kind: "verify", tip: lateDependency }))
		writeFileSync(join(work, "index.ts"), "export const one = 2\n")
		assert.equal(managePatch(root, { kind: "verify", tip: lateDependency }), lateDependency)

		// reorder the dependency changes before the repair
		const reordered = JSON.parse(
			String(managePatch(root, { kind: "order", base, tip: lateDependency, commits: [bump, lateDependency, fix] })),
		) as string[]
		assert.equal(reordered.length, 3)

		// export each mailbox from its own parent and check its subjects
		const upgrade = managePatch(root, { kind: "export", base, tip: fix })
		const adoption = managePatch(root, { kind: "export", base: fix, tip: feature })
		assert.match(String(upgrade), /\[PATCH 1\/2\] chore: bump dependency/)
		assert.match(String(adoption), /\[PATCH\] feat: adopt feature/)

		// check the inspected file contents and reject a symlink edit
		assert.equal(managePatch(root, { kind: "read", file: "index.ts", revision: base }), "export const one = 1\n")
		symlinkSync(join(source, "index.ts"), join(work, "link"))
		assert.throws(() => managePatch(root, { kind: "edit", file: "link", contents: "bad" }))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
