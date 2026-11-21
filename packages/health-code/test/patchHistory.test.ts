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
		mkdirSync(source)
		mkdirSync(work)
		const git = (args: string[]): string =>
			execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", source, ...args], {
				encoding: "utf8",
			}).trim()
		git(["init", "-q"])
		writeFileSync(join(source, "package.json"), '{"version":"1"}\n')
		writeFileSync(join(source, "index.ts"), "export const one = 1\n")
		writeFileSync(join(source, ".env.test"), "TEST_SETTING=example\n")
		git(["add", "-f", "--", ".env.test"])
		git(["add", "."])
		git(["-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-qm", "fixture"])
		const base = git(["rev-parse", "HEAD"])
		const commit = (parent: string, file: string, contents: string, subject: string): string => {
			writeFileSync(join(work, file), contents)
			const result = managePatch(root, { kind: "commit", parent, files: [file], subject })
			assert.equal(typeof result, "string")
			return String(result)
		}
		writeFileSync(join(work, "legacy.txt"), Buffer.from([0x61, 0xe9, 0x0a]))
		const legacy = managePatch(root, {
			kind: "commit",
			parent: base,
			files: ["legacy.txt"],
			subject: "Document legacy encoding",
		})
		assert.throws(() => managePatch(root, { kind: "export", base, tip: String(legacy) }), /encoded|encoding|UTF-8/i)
		writeFileSync(join(work, "index.ts"), "export const one = 1\n")
		writeFileSync(join(work, "package.json"), '{"version":"1"}\n')
		assert.equal(managePatch(root, { kind: "verify", tip: base }), base)
		writeFileSync(join(work, ".env.test"), "changed")
		assert.throws(() => managePatch(root, { kind: "verify", tip: base }), /reappeared/)
		rmSync(join(work, ".env.test"))
		const addTest = {
			kind: "edit" as const,
			file: "added.test.ts",
			contents: 'test("added", () => expect(read()).toBe(1))',
			createTest: true,
		}
		managePatch(root, addTest)
		assert.throws(() => managePatch(root, addTest), /EEXIST|exists/)
		assert.throws(() => managePatch(root, { ...addTest, file: "source.ts" }), /Unsupported new test path/)
		const bump = commit(base, "package.json", '{"version":"2"}\n', "chore: bump dependency")
		const fix = commit(bump, "index.ts", "export const one = 2\n", "fix: support new behavior")
		const feature = commit(fix, "index.ts", "export const two = 2\n", "feat: adopt feature")
		const lateDependency = commit(
			fix,
			"package.json",
			'{"version":"2","dependencies":{"lib":"1.0.0"}}\n',
			"build: add replacement",
		)
		assert.throws(() => managePatch(root, { kind: "verify", tip: lateDependency }))
		writeFileSync(join(work, "index.ts"), "export const one = 2\n")
		assert.equal(managePatch(root, { kind: "verify", tip: lateDependency }), lateDependency)
		const reordered = JSON.parse(
			String(managePatch(root, { kind: "order", base, tip: lateDependency, commits: [bump, lateDependency, fix] })),
		) as string[]
		assert.equal(reordered.length, 3)
		const upgrade = managePatch(root, { kind: "export", base, tip: fix })
		const adoption = managePatch(root, { kind: "export", base: fix, tip: feature })
		assert.match(String(upgrade), /\[PATCH 1\/2\] chore: bump dependency/)
		assert.match(String(adoption), /\[PATCH\] feat: adopt feature/)
		assert.equal(managePatch(root, { kind: "read", file: "index.ts", revision: base }), "export const one = 1\n")
		symlinkSync(join(source, "index.ts"), join(work, "link"))
		assert.throws(() => managePatch(root, { kind: "edit", file: "link", contents: "bad" }))
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
