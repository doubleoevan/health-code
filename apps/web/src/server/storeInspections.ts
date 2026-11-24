import { Database } from "bun:sqlite"
import { randomBytes, randomUUID } from "node:crypto"
import { InspectionError, toInspectionMode, type Upgrade } from "health-code"
import type { SiteEvent, Snapshot } from "../report.ts"
import { isReusableReport, UpgradeCache } from "./cacheUpgrades.ts"
import type { InspectionChoice } from "./inspectionSource.ts"
import { type Publication, readPublishedReport, withheldReason } from "./publishReport.ts"
import { AdmissionLedger, migrateAdmissions } from "./recordAdmissions.ts"

// use the final report's license once it exists and the license recorded before the run until then
const licenseColumn = `CASE WHEN report IS NULL
   THEN (SELECT license FROM inspected_licenses l WHERE l.id=inspections.id) ELSE json_extract(report,'$.license') END`

type StoredRow = Pick<Snapshot, "id" | "state" | "repositoryUrl" | "message"> & { report: string | null }
export class InspectionStore {
	readonly database: Database
	readonly admission: AdmissionLedger
	readonly upgrades: UpgradeCache
	constructor(
		path: string,
		private readonly makeId: () => string = () => randomBytes(12).toString("base64url"),
	) {
		// open the database with concurrent readers enabled
		this.database = new Database(path, { create: true, strict: true })
		this.database.run("PRAGMA journal_mode=WAL")
		const version = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version

		// Capture committed pages and WAL contents before upgrading a persisted schema.
		if ((version === 1 || version === 2) && path !== ":memory:") {
			this.database.query("VACUUM INTO ?").run(`${path}.v${version}.${randomUUID()}.backup`)
		}

		// create the queue, event log and patch store in one transaction
		if (version === 0) {
			this.database.transaction(() =>
				this.database.exec(`
   CREATE TABLE inspections(id TEXT PRIMARY KEY, repositoryUrl TEXT NOT NULL, state TEXT NOT NULL, message TEXT, report TEXT, libraryId TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP, updated TEXT DEFAULT CURRENT_TIMESTAMP);
   CREATE INDEX queued_inspections ON inspections(state);
   CREATE TABLE events(id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,sequence));
   CREATE TABLE patches(digest TEXT PRIMARY KEY,bytes BLOB NOT NULL);
   PRAGMA user_version=1;
  `),
			)()
		} else if (version !== 1 && version !== 2 && version !== 3) {
			throw new Error("Unsupported inspection database version")
		}

		// add storage for the original library report
		if (version === 0 || version === 1) {
			this.database.transaction(() =>
				this.database.exec(
					"CREATE TABLE source_reports(id TEXT PRIMARY KEY,payload TEXT NOT NULL); PRAGMA user_version=2",
				),
			)()
		}
		if (version !== 3) {
			migrateAdmissions(this.database)
		}

		// Attach the admission ledger to this same SQLite connection.
		this.database.exec("CREATE TABLE IF NOT EXISTS inspection_choices(id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
		this.database.exec("CREATE TABLE IF NOT EXISTS inspected_licenses(id TEXT PRIMARY KEY, license TEXT NOT NULL)")
		this.admission = new AdmissionLedger(this.database)
		this.upgrades = new UpgradeCache(this.database)
	}
	position(id: string): number | null {
		// Expose a one-based queue position for durable rows.
		return (
			this.database
				.query<{ position: number }, [string]>(
					`SELECT (SELECT count(*) FROM inspections q WHERE q.state='queued' AND q.rowid<=i.rowid) position FROM inspections i WHERE id=? AND state='queued'`,
				)
				.get(id)?.position ?? null
		)
	}

	// Recover the inspected revision after a worker restart.
	checkout(id: string): { revision: string; repositoryId: string } | null {
		return this.database
			.query<{ revision: string; repositoryId: string }, [string]>(
				"SELECT revision,json_extract(cacheKey,'$[0]') repositoryId FROM admissions WHERE id=?",
			)
			.get(id)
	}
	private queueFull(): boolean {
		// check whether the waiting queue has reached its limit
		const maximumQueued = 32
		return (
			this.database.query("SELECT 1 FROM inspections WHERE state='queued' LIMIT 1 OFFSET ?").get(maximumQueued - 1) !==
			null
		)
	}

	// Restore the submitted target after a worker restart.
	choice(id: string): InspectionChoice | undefined {
		const row = this.database
			.query<{ payload: string }, [string]>("SELECT payload FROM inspection_choices WHERE id=?")
			.get(id)
		if (!row) {
			return undefined
		}

		// Resume jobs queued before the explicit inspection mode was stored.
		const { discoveryOnly, ...choice }: InspectionChoice & { discoveryOnly?: boolean } = JSON.parse(row.payload)
		if (discoveryOnly !== undefined) {
			choice.mode = toInspectionMode({ mode: choice.mode, discoveryOnly })
		}
		return choice
	}

	// find the repository's newest upgrade menu
	private findUpgradeMenuId(repositoryUrl: string): string | undefined {
		// skip inspections of one upgrade and empty upgrade menus
		return this.database
			.query<{ id: string }, [string]>(`
			SELECT i.id FROM inspections i JOIN inspection_choices c ON c.id=i.id
			WHERE i.repositoryUrl=? COLLATE NOCASE AND i.state='complete' AND json_extract(c.payload,'$.upgrade') IS NULL
			AND json_array_length(coalesce(json_extract(i.report,'$.upgradeMenu'),json_extract(i.report,'$.menu')))>0
			ORDER BY i.rowid DESC LIMIT 1`)
			.get(repositoryUrl)?.id
	}

	upgradeMenuTarget({
		upgradeMenuId,
		dependency,
		to,
	}: {
		upgradeMenuId: string
		dependency: string
		to: string
	}): Upgrade | undefined {
		// Read only the workspace pins and target needed for release lookup.
		const row = this.database
			.query<{ value: string }, [string, string, string]>(`
			SELECT item.value FROM inspections i, json_each(coalesce(json_extract(i.report,'$.upgradeMenu'),json_extract(i.report,'$.menu'))) item
			WHERE i.id=? AND json_extract(item.value,'$.dependency')=? AND json_extract(item.value,'$.to')=? LIMIT 1`)
			.get(upgradeMenuId, dependency, to)
		return row ? JSON.parse(row.value) : undefined
	}

	requestedWork(id: string, checkout: { revision: string } | null): InspectionChoice {
		const choice = this.choice(id)
		return { ...choice, revision: checkout?.revision ?? choice?.revision }
	}

	enqueue(repositoryUrl: string, choice?: InspectionChoice): string {
		// Save the requested work alongside its queue entry in one transaction.
		return this.database.transaction(() => {
			const id = this.enqueueRepository(repositoryUrl)
			if (choice) {
				this.database.query("INSERT INTO inspection_choices VALUES(?,?)").run(id, JSON.stringify(choice))
			}
			return id
		})()
	}

	// Insert the inspection into the bounded queue.
	private enqueueRepository(repositoryUrl: string): string {
		// Apply the queue bound to every fresh insertion.
		if (this.queueFull()) {
			throw new InspectionError("queue-full", "The inspection queue is full. Try again after an inspection starts.")
		}

		// retry id collisions without replacing another inspection
		for (;;) {
			const id = this.makeId()
			if (
				this.database
					.query("INSERT INTO inspections(id,repositoryUrl,state) VALUES(?,?,'queued') ON CONFLICT(id) DO NOTHING")
					.run(id, repositoryUrl).changes
			) {
				// expose the public id only after its queue entry exists
				return id
			}
		}
	}

	// claim the oldest waiting inspection in one update
	claim(): StoredRow | null {
		return this.database
			.query<StoredRow, []>(
				"UPDATE inspections SET state='running',updated=CURRENT_TIMESTAMP WHERE rowid=(SELECT rowid FROM inspections WHERE state='queued' ORDER BY rowid LIMIT 1) RETURNING *",
			)
			.get()
	}

	// Preserve FIFO order and the hold when dispatch needs a fresh admission check.
	requeue(id: string): void {
		this.database
			.query("UPDATE inspections SET state='queued',updated=CURRENT_TIMESTAMP WHERE state='running' AND id=?")
			.run(id)
	}

	// remove a waiting inspection and release its reservation
	stopQueued(id: string, message: string): boolean {
		return this.database.transaction(() => {
			const { changes } = this.database
				.query(
					"UPDATE inspections SET state='stopped',message=?,updated=CURRENT_TIMESTAMP WHERE state='queued' AND id=?",
				)
				.run(message, id)

			// free the budget held for the removed inspection
			if (changes) {
				this.admission.release(id)
			}
			return changes > 0
		})()
	}

	// mark jobs left running by a previous process
	interrupt(): { id: string; repositoryUrl: string; durationMs: number }[] {
		return this.database
			.transaction(() => {
				const abandoned = this.database
					.query<{ id: string; repositoryUrl: string; durationMs: number }, []>(
						"SELECT id,repositoryUrl,max(0,unixepoch('now')-unixepoch(updated))*1000 durationMs FROM inspections WHERE state='running'",
					)
					.all()

				// Mark and report exactly the inspections claimed by the previous process.
				this.database
					.query("UPDATE inspections SET state='interrupted',message=?,updated=CURRENT_TIMESTAMP WHERE state='running'")
					.run("This inspection was interrupted when the server restarted. You can start a new inspection.")
				return abandoned
			})
			.immediate()
	}

	append(id: string, event: SiteEvent): void {
		// store each event once for the public inspection id
		this.database.transaction(() => {
			this.database
				.query("INSERT INTO events VALUES(?,?,?) ON CONFLICT DO NOTHING")
				.run(id, event.sequence, JSON.stringify(event))

			// associate the public id with the library id at startup
			if (event.type === "inspection.started") {
				this.database.query("UPDATE inspections SET libraryId=? WHERE id=?").run(event.inspectionId, id)
			}
		})()
	}

	// fetch the current inspection row by its public id
	row(id: string): StoredRow | null {
		return this.database.query<StoredRow, [string]>("SELECT * FROM inspections WHERE id=?").get(id)
	}
	snapshot(id: string): Snapshot | null {
		// read state, public events and report in one transaction
		return this.database.transaction(() => {
			const row = this.row(id)
			if (!row) {
				return null
			}
			const events = this.publicEvents(id, 0)
			const report: Snapshot["card"] = row.report ? readPublishedReport(row.report) : null

			// Refresh patch availability from published, licensed artifacts.
			if (report?.upgradeMenu) {
				this.upgrades.attachPatches(row.id, report)
			}

			// Preserve the reason on reports saved with the earlier field name.
			if (
				report &&
				!report.registryLookupIssue &&
				"discoveryIssue" in report &&
				typeof report.discoveryIssue === "string"
			) {
				report.registryLookupIssue = report.discoveryIssue
			}

			// Recover the reason from the timeline when an empty report has none.
			if (
				report &&
				!report.registryLookupIssue &&
				!report.upgrades.length &&
				events.some(
					(event) => event.type === "step.finished" && event.summary === "registry" && event.status === "failed",
				)
			) {
				report.registryLookupIssue = "Couldn’t list available upgrades: registry lookup failed."
			}

			const choice = this.choice(id)
			return {
				id: row.id,
				state: row.state,
				position: this.position(id),
				mode: choice?.mode,
				selectedDependencyUpgrade: choice?.upgrade,
				upgradeMenuId: this.findUpgradeMenuId(row.repositoryUrl),
				message: row.message,
				repositoryUrl: row.repositoryUrl,
				events,
				card: report,
			}
		})()
	}

	// look up the state without loading the event history
	state(id: string): Snapshot["state"] | undefined {
		return this.database
			.query<{ state: Snapshot["state"] }, [string]>("SELECT state FROM inspections WHERE id=?")
			.get(id)?.state
	}
	publicEvents(id: string, after: number, limit = -1): SiteEvent[] {
		// withhold raw command output from the initial page and event stream
		const events = this.database.query<{ payload: string }, [string, number, number]>(`
   SELECT CASE WHEN json_extract(payload,'$.type')='detail' THEN json_set(payload,'$.text',CASE WHEN ${licenseColumn} IS NOT NULL THEN ''
        WHEN state IN ('queued','running') THEN 'Output is hidden until GitHub confirms an open source license for this repo...'
        ELSE '${withheldReason}' END)
     ELSE payload END AS payload
   FROM events JOIN inspections USING(id) WHERE id=? AND sequence>? ORDER BY sequence LIMIT ?
   `)

		// page by event sequence and decode the filtered payloads
		return events.all(id, after, limit).map((row) => JSON.parse(row.payload))
	}

	// record the license found at the inspected commit before the sandbox starts
	saveInspectedLicense(id: string, license: string | null): void {
		this.database.query("DELETE FROM inspected_licenses WHERE id=?").run(id)
		if (license) {
			this.database.query("INSERT INTO inspected_licenses VALUES(?,?)").run(id, license)
		}
	}

	// reveal raw detail text only after license verification
	detail(id: string, sequence: number): string | null {
		return (
			this.database
				.query<{ text: string }, [string, number]>(`
   SELECT json_extract(payload,'$.text') AS text FROM events JOIN inspections USING(id)
   WHERE id=? AND sequence=? AND ${licenseColumn} IS NOT NULL AND json_extract(payload,'$.type')='detail'
   `)

				// return null if the event lacks a public detail
				.get(id, sequence)?.text ?? null
		)
	}
	finish(id: string, publication: Publication): void {
		// publish the original report, patch bytes and public report atomically
		this.database.transaction(() => {
			const report = publication.original
			if (report.version === 2) {
				this.admission.settle(id, report.runtimeUsage)
				this.upgrades.save({ id, report, published: publication.card })
			}

			// Release incomplete reports for a fresh submission.
			if (!isReusableReport(report)) {
				this.database.query("UPDATE admissions SET cacheKey=NULL WHERE id=?").run(id)
			} else if (report.selection.omitted.length && report.selection.limit !== undefined) {
				// Match the complete report to a limit lowered before dispatch.
				this.database
					.query("UPDATE admissions SET cacheKey=json_set(cacheKey,'$[4]',?) WHERE id=? AND json_valid(cacheKey)")
					.run(report.selection.limit, id)
			}

			// Store immutable patch bytes alongside their source report.
			this.database.query("INSERT INTO source_reports VALUES(?,?)").run(id, JSON.stringify(publication.original))
			for (const [digest, bytes] of publication.blobs) {
				this.database.query("INSERT INTO patches VALUES(?,?) ON CONFLICT DO NOTHING").run(digest, bytes)
			}

			// mark the inspection complete with its public projection
			this.database
				.query("UPDATE inspections SET state='complete',report=?,updated=CURRENT_TIMESTAMP WHERE id=?")
				.run(JSON.stringify(publication.card), id)
		})()
	}

	// record the terminal failure message for reconnecting clients
	fail(input: {
		id: string
		message: string
		dispatched: boolean
		state?: "failed" | "stopped"
		failure?: InspectionError
	}): void {
		const { id, state = "failed", message, dispatched, failure } = input

		// Commit accounting, missing events and the terminal state together for safe retries.
		this.database.transaction(() => {
			if (!dispatched) {
				this.admission.release(id)
			}

			if (failure) {
				this.admission.settle(id, failure.runtimeUsage)
				for (const event of failure.timeline) {
					this.append(id, event)
				}
			}

			// Store only the message intended for public display.
			this.database
				.query("UPDATE inspections SET state=?,message=?,updated=CURRENT_TIMESTAMP WHERE id=?")
				.run(state, message, id)
		})()
	}

	// look up the exact bytes for a verified patch digest
	patch(digest: string): Uint8Array | null {
		return (
			this.database.query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM patches WHERE digest=?").get(digest)
				?.bytes ?? null
		)
	}
}
