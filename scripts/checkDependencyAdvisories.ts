import { readFileSync } from "node:fs"
import { z } from "zod"

const advisory = z.object({
	id: z.number(),
	url: z.string(),
	title: z.string(),
	severity: z.enum(["info", "low", "moderate", "high", "critical"]),
	vulnerable_versions: z.string(),
})
const audit = z.record(z.string().min(1), z.array(advisory))
const reviewed = z.array(
	z.strictObject({
		advisoryId: z.string().trim().min(1),
		packageName: z.string().trim().min(1),
		reason: z.string().trim().min(1),
		reviewedAt: z.iso.date(),
	}),
)

/**
 * Lists open high and critical advisories and exceptions that no longer match the audit.
 */
export function toAdvisoryViolations(output: string, allowlistText: string): string[] {
	// index reviewed exceptions by package and advisory
	const advisories = audit.parse(JSON.parse(output))
	const entries = reviewed.parse(JSON.parse(allowlistText))
	const allowed = new Set(entries.map((entry) => toAdvisoryKey(entry.packageName, entry.advisoryId)))
	const listed = new Set<string>()
	const violations: string[] = []

	// compare each registry finding with its reviewed exception
	for (const [name, findings] of Object.entries(advisories)) {
		for (const finding of findings) {
			// Prefer the stable GHSA identifier over the registry's numeric id.
			const id = /GHSA(?:-[a-z0-9]{4}){3}$/.exec(finding.url)?.[0] ?? String(finding.id)
			const key = toAdvisoryKey(name, id)
			listed.add(key)
			if ((finding.severity === "high" || finding.severity === "critical") && !allowed.has(key)) {
				violations.push(`${key} (${finding.severity}, ${finding.vulnerable_versions}): ${finding.title}`)
			}
		}
	}

	// report exceptions whose advisories have cleared
	return [
		...violations,
		...[...allowed].filter((key) => !listed.has(key)).map((key) => `remove stale exception: ${key}`),
	]
}

function toAdvisoryKey(packageName: string, id: string): string {
	return `${packageName} ${id}`
}

if (import.meta.main) {
	const result = Bun.spawnSync(["bun", "audit", "--json"], { stdout: "pipe", stderr: "pipe" })
	const output = result.stdout.toString().trim()

	// Bun also exits one when it successfully reports advisories.
	if (result.exitCode !== 0 && (result.exitCode !== 1 || !output || output === "{}")) {
		throw new Error("bun audit could not complete the registry check")
	}

	// print every unreviewed finding and stale exception
	const violations = toAdvisoryViolations(output, readFileSync("dependency-advisories.json", "utf8"))
	if (violations.length > 0) {
		console.error(violations.join("\n"))
		process.exit(1)
	}
	console.log("dependency advisories reviewed")
}
