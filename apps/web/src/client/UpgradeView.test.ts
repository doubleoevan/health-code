import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CheckOutcome } from "./UpgradeView.tsx"

test("a collapsed test result shows its failed status and counts", () => {
	const names = "behavior ".repeat(20)
	const render = (text: string): string => renderToStaticMarkup(createElement(CheckOutcome, { text }))

	// keep the status visible even when no named case failed
	expect(render(`failed · 1200 passed, 0 failed, 3 skipped, 0 todo · ${names}`)).toContain(
		"<summary>failed · 1,203 tests · 0 failed</summary>",
	)
	expect(render(`passed · 1 passed, 0 failed, 0 skipped, 0 todo · ${names}`)).toContain(
		"<summary>1 test · 0 failed</summary>",
	)

	// list each failing test name with its apostrophes restored
	const saved = render(`failed · 1 passed, 2 failed, 0 skipped, 0 todo · the post&apos;s path is dropped, ${names}`)
	expect(saved).toContain("<p>failed · 1 passed, 2 failed, 0 skipped, 0 todo</p>")
	expect(saved).toContain("<li>the post&#x27;s path is dropped</li>")
	expect(render("failed · 0 passed, 2 failed, 0 skipped, 0 todo · first, with a comma\nsecond")).toContain(
		"<li>first, with a comma</li><li>second</li>",
	)

	// show short results in full
	expect(render("failed · Install stopped")).toBe("failed · Install stopped")
})
