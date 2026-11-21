import { Database } from "bun:sqlite"
import { randomBytes } from "node:crypto"
import type { Publication } from "./publishReport.ts"
import type { SiteEvent, Snapshot } from "./report.ts"

type StoredRow = Pick<Snapshot, "id" | "state" | "repositoryUrl" | "message"> & { report: string | null }
export class InspectionStore {
	readonly database: Database
	constructor(
		path: string,
		private readonly makeId: () => string = () => randomBytes(12).toString("base64url"),
	) {
		this.database = new Database(path, { create: true, strict: true })
		this.database.run("PRAGMA journal_mode=WAL")
		const version = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
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
		} else if (version !== 1 && version !== 2) {
			throw new Error("Unsupported inspection database version")
		}
		if (version !== 2) {
			this.database.transaction(() =>
				this.database.exec(
					"CREATE TABLE source_reports(id TEXT PRIMARY KEY,payload TEXT NOT NULL); PRAGMA user_version=2",
				),
			)()
		}
	}

	queueFull(): boolean {
		const maximumQueued = 32
		return (
			this.database.query("SELECT 1 FROM inspections WHERE state='queued' LIMIT 1 OFFSET ?").get(maximumQueued - 1) !==
			null
		)
	}
	enqueue(repositoryUrl: string): string {
		for (;;) {
			const id = this.makeId()
			if (
				this.database
					.query("INSERT INTO inspections(id,repositoryUrl,state) VALUES(?,?,'queued') ON CONFLICT(id) DO NOTHING")
					.run(id, repositoryUrl).changes
			) {
				return id
			}
		}
	}
	claim(): StoredRow | null {
		return this.database
			.query<StoredRow, []>(
				"UPDATE inspections SET state='running',updated=CURRENT_TIMESTAMP WHERE rowid=(SELECT rowid FROM inspections WHERE state='queued' ORDER BY rowid LIMIT 1) RETURNING *",
			)
			.get()
	}
	interrupt(): void {
		this.database
			.query("UPDATE inspections SET state='interrupted',message=?,updated=CURRENT_TIMESTAMP WHERE state='running'")
			.run("This inspection was interrupted when the server restarted. You can start a new inspection.")
	}
	append(id: string, event: SiteEvent): void {
		this.database.transaction(() => {
			this.database
				.query("INSERT INTO events VALUES(?,?,?) ON CONFLICT DO NOTHING")
				.run(id, event.sequence, JSON.stringify(event))
			if (event.type === "inspection.started") {
				this.database.query("UPDATE inspections SET libraryId=? WHERE id=?").run(event.inspectionId, id)
			}
		})()
	}
	row(id: string): StoredRow | null {
		return this.database.query<StoredRow, [string]>("SELECT * FROM inspections WHERE id=?").get(id)
	}
	snapshot(id: string): Snapshot | null {
		return this.database.transaction(() => {
			const row = this.row(id)
			if (!row) {
				return null
			}
			return {
				id: row.id,
				state: row.state,
				message: row.message,
				repositoryUrl: row.repositoryUrl,
				events: this.publicEvents(id, 0),
				card: row.report ? JSON.parse(row.report) : null,
			}
		})()
	}
	state(id: string): Snapshot["state"] | undefined {
		return this.database
			.query<{ state: Snapshot["state"] }, [string]>("SELECT state FROM inspections WHERE id=?")
			.get(id)?.state
	}
	publicEvents(id: string, after: number, limit = -1): SiteEvent[] {
		// Keep buffered command output out of both initial HTML and event-stream pages.
		return this.database
			.query<{ payload: string }, [string, number, number]>(`
   SELECT CASE WHEN json_extract(payload,'$.type')='detail'
     THEN json_set(payload,'$.text',CASE WHEN json_extract(report,'$.license') IS NULL
        THEN 'Output withheld until an open source license is verified.' ELSE '' END)
     ELSE payload END AS payload
   FROM events JOIN inspections USING(id) WHERE id=? AND sequence>? ORDER BY sequence LIMIT ?
   `)
			.all(id, after, limit)
			.map((row) => JSON.parse(row.payload))
	}
	detail(id: string, sequence: number): string | null {
		return (
			this.database
				.query<{ text: string }, [string, number]>(`
   SELECT json_extract(payload,'$.text') AS text FROM events JOIN inspections USING(id)
   WHERE id=? AND sequence=? AND json_extract(report,'$.license') IS NOT NULL AND json_extract(payload,'$.type')='detail'
   `)
				.get(id, sequence)?.text ?? null
		)
	}
	finish(id: string, publication: Publication): void {
		this.database.transaction(() => {
			this.database.query("INSERT INTO source_reports VALUES(?,?)").run(id, JSON.stringify(publication.original))
			for (const [digest, bytes] of publication.blobs) {
				this.database.query("INSERT INTO patches VALUES(?,?) ON CONFLICT DO NOTHING").run(digest, bytes)
			}
			this.database
				.query("UPDATE inspections SET state='complete',report=?,updated=CURRENT_TIMESTAMP WHERE id=?")
				.run(JSON.stringify(publication.card), id)
		})()
	}
	fail(id: string, message: string): void {
		this.database
			.query("UPDATE inspections SET state='failed',message=?,updated=CURRENT_TIMESTAMP WHERE id=?")
			.run(message, id)
	}
	patch(digest: string): Uint8Array | null {
		return (
			this.database.query<{ bytes: Uint8Array }, [string]>("SELECT bytes FROM patches WHERE digest=?").get(digest)
				?.bytes ?? null
		)
	}
}
