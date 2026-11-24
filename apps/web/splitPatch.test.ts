import { expect, test } from "bun:test"
import { splitPatch } from "./splitPatch.ts"

const header = `From ${"a".repeat(40)} Mon Sep 17 00:00:00 2001\nSubject: [PATCH] upgrade\n---\n`
const lockfile =
	"diff --git a/apps/b/package-lock.json b/apps/b/package-lock.json\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-1\n+2\n"
const source = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"

test("a patch folds each lockfile and keeps later files and commits", () => {
	// close the first commit with its signature before the next commit begins
	const sections = splitPatch(`${header}${source}${lockfile}-- \n2.53.0\n\n${header}${source}`)
	expect(sections.map((section) => section.isFolded)).toEqual([false, false, true, false, false])
	expect(sections[2]?.text).toBe("apps/b/package-lock.json · 2 changed lines. Download the patch to see them.")
	expect(sections[4]?.text).toBe(source)
})

test("a patch folds files past the display limit", () => {
	const sections = splitPatch(`${source}${"diff --git a/big.ts b/big.ts\n"}${"+x\n".repeat(40_000)}`)
	expect(sections.map((section) => section.isFolded)).toEqual([false, true])
	expect(sections[1]?.text).toContain("big.ts · Download")
})
