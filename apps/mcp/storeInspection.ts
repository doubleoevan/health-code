import { createHash, randomUUID } from "node:crypto"
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve } from "node:path"
import * as z from "zod"
import { UserError } from "./modelSettings.ts"

const reportFile = "inspection-report.json"

export const inspectionId = z.uuid()
export const digest = z.string().regex(/^[a-f0-9]{64}$/)
const commit = z.string().regex(/^[a-f0-9]{40}$/)
const repository = z.looseObject({ url: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/), commit })
export const eventSchema = z.looseObject({
	inspectionId,
	sequence: z.number().int().nonnegative(),
	type: z.enum([
		"inspection.started",
		"step.started",
		"step.finished",
		"detail",
		"sandbox.event",
		"inspection.finished",
		"inspection.failed",
	]),
})
export const reportSchema = z.looseObject({
	version: z.union([z.literal(1), z.literal(2)]),
	inspectionId,
	repository,
	baseline: z.looseObject({}),
	upgrades: z.array(z.looseObject({ dependency: z.string() })),
	timeline: z.array(eventSchema),
})
export type SavedReport = z.infer<typeof reportSchema>
export type Event = z.infer<typeof eventSchema>
export const outcomeSchema = z.object({
	inspectionId,
	sha256: digest,
	application: z.enum(["clean", "adapted"]),
	adaptation: z.string().trim().min(1).max(2000).optional(),
	tests: z.enum(["passed", "failed", "not_run"]),
	pullRequest: z.url().max(500).optional(),
})
export type Outcome = z.infer<typeof outcomeSchema>

export function toHash(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex")
}
export function protect(environment: NodeJS.ProcessEnv): (text: string) => void {
	const secrets = [environment.MODEL_API_KEY, environment.RUNTA_TOKEN, environment.GITHUB_TOKEN].filter(
		(key): key is string => Boolean(key),
	)

	// screen both raw credentials and their serialized forms
	return (text) => {
		if (secrets.some((key) => text.includes(key) || text.includes(JSON.stringify(key).slice(1, -1)))) {
			throw new UserError("Evidence withheld because it contains a configured credential.")
		}
	}
}

function hasFileErrorCode(error: unknown, code: "ENOENT" | "EEXIST"): boolean {
	return error instanceof Error && "code" in error && error.code === code
}

type Snapshot = { report: SavedReport; text: string }

export class InspectionStore {
	private lastSnapshot?: { identity: string; snapshot: Snapshot }
	constructor(
		readonly root = join(homedir(), ".health-code", "inspections"),
		readonly guard = protect(process.env),
	) {}
	private folder(id: string): string {
		return join(this.root, inspectionId.parse(id))
	}
	private async checkPath(path: string): Promise<void> {
		// Reject links beneath the private storage root before traversing local evidence.
		const root = await realpath(this.root)
		if ((await realpath(path)) !== resolve(root, relative(this.root, path))) {
			throw new UserError("Inspection storage contains an unexpected link.")
		}
	}

	// Resolve both report filenames through the inspection storage boundary.
	private async reportPath(id: string): Promise<string> {
		const folder = this.folder(id)
		const path = join(folder, reportFile)
		try {
			await this.checkPath(path)
			return path
		} catch (error) {
			// Propagate unreadable or unsafe paths before checking the earlier filename.
			if (!hasFileErrorCode(error, "ENOENT")) {
				throw error
			}
		}

		// Open reports written by earlier MCP versions under the same inspection ID.
		const previous = join(folder, "card.json")
		await this.checkPath(previous)
		return previous
	}

	private async read(path: string): Promise<unknown> {
		// limit reads to regular files within the storage size limit
		await this.checkPath(path)
		const stat = await lstat(path)
		if (!stat.isFile() || stat.size > 64 * 1024 * 1024) {
			throw new UserError("Inspection record has an unsupported size or type.")
		}

		// check stored text for configured credentials before parsing
		const text = await readFile(path, "utf8")
		this.guard(text)
		return JSON.parse(text)
	}
	async save(input: SavedReport): Promise<void> {
		// validate the entire report before creating its directory
		const report = reportSchema.parse(input)
		const target = this.folder(report.inspectionId)
		const text = JSON.stringify(report)
		this.guard(text)
		if (Buffer.byteLength(text) > 64 * 1024 * 1024) {
			throw new UserError("Inspection Report exceeds local storage limit.")
		}

		// stage the report and its result directory with private permissions
		await mkdir(this.root, { recursive: true, mode: 0o700 })
		const temp = await mkdtemp(join(this.root, ".pending-"))
		try {
			await writeFile(join(temp, reportFile), text, { mode: 0o600 })
			await mkdir(join(temp, "results"), { mode: 0o700 })
			await rename(temp, target)
		} finally {
			// remove the staging directory if publication fails
			await rm(temp, { recursive: true, force: true })
		}
	}
	async reportIds(): Promise<string[]> {
		// Enumerate only published report directories under the private storage root.
		const entries = await readdir(this.root, { withFileTypes: true })
		return entries
			.filter((entry) => entry.isDirectory() && inspectionId.safeParse(entry.name).success)
			.map((entry) => entry.name)
	}

	async load(id: string): Promise<SavedReport> {
		return (await this.snapshot(id)).report
	}

	// read the report together with the exact text used for paging
	async snapshot(id: string): Promise<Snapshot> {
		try {
			const path = await this.reportPath(id)
			const stat = await lstat(path, { bigint: true })
			if (!stat.isFile() || stat.size > 64n * 1024n * 1024n) {
				throw new UserError("Inspection Report has an unsupported size or type.")
			}

			// Reuse one immutable report across cursor reads until its on-disk identity changes.
			const identity = [id, stat.dev, stat.ino, stat.size, stat.ctimeNs, stat.mtimeNs].join("/")
			if (this.lastSnapshot?.identity === identity) {
				return this.lastSnapshot.snapshot
			}

			// validate a changed file before replacing the cached snapshot
			const text = await readFile(path, "utf8")
			this.guard(text)
			const report = reportSchema.parse(JSON.parse(text))
			if (report.inspectionId !== id || report.timeline.some((event) => event.inspectionId !== id)) {
				throw new Error()
			}

			// cache the original text beside the validated report
			const snapshot = { report, text }
			this.lastSnapshot = { identity, snapshot }
			return snapshot
		} catch (error) {
			// distinguish a missing inspection from unreadable saved evidence
			if (hasFileErrorCode(error, "ENOENT")) {
				throw new UserError("Inspection not found. Active inspections belong to their server process.")
			}
			throw new UserError("Saved Inspection Report is unreadable.")
		}
	}
	async record(outcome: Outcome): Promise<void> {
		// validate the application result before opening storage
		const text = JSON.stringify(outcomeSchema.parse(outcome))
		this.guard(text)
		const folder = this.folder(outcome.inspectionId)
		await this.checkPath(folder)

		// prepare a private results directory beneath the inspection root
		const directory = join(folder, "results")
		await mkdir(directory, { recursive: true, mode: 0o700 })
		await this.checkPath(directory)
		const temp = join(directory, `.pending-${randomUUID()}`)
		try {
			await writeFile(temp, text, { mode: 0o600, flag: "wx" })

			// Publish a complete immutable record, even when two clients retry together.
			await link(temp, join(directory, `${toHash(text)}.json`))
		} catch (error) {
			// treat concurrent publication of identical results as a successful retry
			if (!hasFileErrorCode(error, "EEXIST")) {
				throw error
			}
		} finally {
			await rm(temp, { force: true })
		}
	}
	async outcomes(id: string): Promise<Outcome[]> {
		// enumerate results in a stable order by digest
		const directory = join(this.folder(id), "results")
		let names: string[]
		try {
			await this.checkPath(directory)
			names = (await readdir(directory)).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).sort()
		} catch (error) {
			// return an empty history when result storage is absent
			if (hasFileErrorCode(error, "ENOENT")) {
				return []
			}
			throw error
		}
		const results: Outcome[] = []

		// verify each record against its inspection id and content-addressed filename
		for (const name of names) {
			const record = outcomeSchema.parse(await this.read(join(directory, name)))
			if (record.inspectionId !== id || name !== `${toHash(JSON.stringify(record))}.json`) {
				throw new UserError("Saved Patch result is unreadable.")
			}

			// retain only results whose identity checks succeeded
			results.push(record)
		}
		return results
	}
}
