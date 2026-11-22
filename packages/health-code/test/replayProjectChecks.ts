import { readFileSync } from "node:fs"
import { test } from "node:test"
import { createFakeSandboxProvider, type FixtureCommand, type Observation, type SandboxProvider } from "../src/index.ts"
import { fixtureCommit } from "./providerContract.ts"

export const base = ["node", "/opt/health-code/project.mjs"]
export const clean: Observation = { complete: true, findings: [] }
export function command(args: string[], stdout = "", exitCode = 0): FixtureCommand {
	return { argv: [...base, ...args], result: { stdout, exitCode } }
}
export function report(names: string[]): FixtureCommand {
	return command(
		["report"],
		JSON.stringify({
			complete: true,
			granularity: "case",
			failures: names.map((name) => ({ file: "unit.test.js", workspace: ".", name })),
		}),
	)
}
export function scripts(baseline: string[], upgraded: string[], repeated: string[]): FixtureCommand[] {
	const transcript = JSON.parse(
		readFileSync(new URL("./fixtures/recorded/pnpm/transcript.json", import.meta.url), "utf8"),
	)

	// replay baseline and upgrade checks in execution order
	const steps = [
		command(["detect"], JSON.stringify(transcript.project)),
		command(["registry", "widget"], JSON.stringify(transcript.registry)),
		command(["install"]),
		command(["typecheck", "build"]),
		command(["tests"], "", Number(!!baseline.length)),
		report(baseline),
		command(["install", "widget", "1.3.0"]),
		command(["typecheck", "build"]),
		command(["tests"], "", Number(!!upgraded.length)),
		report(upgraded),
	]

	// append a confirmation run only for newly failing cases
	if (upgraded.some((name) => !baseline.includes(name))) {
		steps.push(
			command(["install", "widget", "1.3.0"]),
			command(["typecheck", "build"]),
			command(["tests"], "", Number(!!repeated.length)),
			report(repeated),
		)
	}
	return steps
}
export function provider(commands: FixtureCommand[]): SandboxProvider {
	return createFakeSandboxProvider({ commit: fixtureCommit, commands })
}
