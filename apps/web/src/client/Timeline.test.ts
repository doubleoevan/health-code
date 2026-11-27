import { expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { SiteEvent } from "../report.ts"
import { Timeline } from "./Timeline.tsx"

test("a saved model request sandbox startup is shown once in the sandbox event list and once in the timeline", () => {
	const detail = "Model request sandbox started. Runta supplies the model key. This machine doesn’t need it."
	const event: SiteEvent = {
		version: 2,
		inspectionId: "recorded",
		sandboxId: "recorded-relay",
		type: "sandbox.event",
		action: "model-request-sandbox-started",
		sequence: 4,
		timestamp: new Date(0).toISOString(),
		detail,
	}
	const html = renderToStaticMarkup(createElement(Timeline, { id: "recorded", live: false, events: [event] }))
	expect(html.split(detail)).toHaveLength(3)

	// Replay the original action and detail from an earlier saved Inspection.
	const historical: SiteEvent = {
		...event,
		action: "model-relay-started",
		detail: detail.replace("Model request sandbox started", "Model relay started"),
	}
	const replayed = renderToStaticMarkup(createElement(Timeline, { id: "recorded", live: false, events: [historical] }))
	expect(replayed.split(detail)).toHaveLength(3)
})

test("live and saved timelines show measured key counts and preserve uncounted events", () => {
	const event = {
		type: "sandbox.event",
		action: "credentials-withheld",
		version: 2,
		inspectionId: "recorded",
		sandboxId: "sandbox",
		sequence: 1,
		timestamp: new Date(0).toISOString(),
	} as const
	for (const live of [true, false]) {
		for (const [measurement, label] of [
			[{ storedModelKeyCount: 1 }, "1 model key kept outside the sandbox"],
			[{ storedModelKeyCount: 2 }, "2 model keys kept outside the sandbox"],
			[{ placeholderVariableCount: 0 }, "0 repository environment variables given placeholder values"],
			[{ placeholderVariableCount: 1 }, "1 repository environment variable given placeholder values"],
			[{ placeholderVariableCount: 3 }, "3 repository environment variables given placeholder values"],
			[{}, "Keys kept outside the sandbox"],
		] as const) {
			const events: SiteEvent[] = [{ ...event, ...measurement }]
			const html = renderToStaticMarkup(createElement(Timeline, { id: "recorded", live, events }))
			expect(html.split(label)).toHaveLength(3)
		}
	}
})

test("the live and saved timelines label registry lookup and its partial results", () => {
	const base = { version: 1 as const, inspectionId: "recorded", timestamp: new Date(0).toISOString(), stepId: "1" }
	const started: SiteEvent = { ...base, sequence: 1, type: "step.started", label: "registry" }
	const finished: SiteEvent = {
		...base,
		sequence: 2,
		type: "step.finished",
		summary: "registry",
		status: "untested",
		durationMs: 500,
	}
	const live = renderToStaticMarkup(createElement(Timeline, { id: "recorded", live: true, events: [started] }))
	expect(live).toContain("Find available upgrades")

	// Keep the public event status while showing the reader which stage was incomplete.
	const saved = renderToStaticMarkup(createElement(Timeline, { id: "recorded", live: false, events: [finished] }))
	expect(saved).toContain("Find available upgrades")
	expect(saved).toContain("Incomplete · 0.5s")
})

test("the inspection log stays hidden until it has an entry", () => {
	const render = (events: SiteEvent[]): string =>
		renderToStaticMarkup(createElement(Timeline, { id: "recorded", live: true, events }))
	const base = { version: 1 as const, inspectionId: "recorded", timestamp: new Date(0).toISOString() }
	expect(render([])).toBe("")

	// show the active step before the log has a finished entry
	const started: SiteEvent = { ...base, sequence: 1, type: "step.started", label: "registry", stepId: "1" }
	expect(render([started])).not.toContain("Inspection log")
	expect(render([{ ...base, sequence: 1, type: "inspection.started" } as SiteEvent])).toContain("Inspection log")
})

test("saved steps use the current inspected wording", () => {
	const event: SiteEvent = {
		version: 1,
		inspectionId: "recorded",
		sequence: 1,
		timestamp: new Date(0).toISOString(),
		type: "step.started",
		label: "Restore pinned project",
		stepId: "1",
	}
	const html = renderToStaticMarkup(createElement(Timeline, { id: "recorded", live: false, events: [event] }))
	expect(html).toContain("Restore inspected project")
})
