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

	// show short results in full
	expect(render("failed · Install stopped")).toBe("failed · Install stopped")
})
