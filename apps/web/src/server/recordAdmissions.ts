import type { Database } from "bun:sqlite"
import type { LaunchLimits } from "./launchLimits.ts"

export type RepositoryHead = { repositoryId: string; revision: string; sizeKiB: number; canonicalUrl?: string }
export type Visitor = { visitor: string; network: string }
type DailyActivity = {
	// Daily counts and cost totals use the UTC calendar.
	day: string
	completed: number
	counts: string
	modelMicros: number

	// Keep bounded runtime charges separate from measured model cost.
	sandboxUpperMicros: number
	pendingMicros: number
	settledUpperMicros: number
}
// Use the small queued choice to distinguish upgrade menus from shareable reports.
const shareableReport = `NOT EXISTS (
	SELECT 1 FROM inspection_choices c WHERE c.id=inspections.id
	AND coalesce(json_extract(c.payload,'$.mode')='listUpgrades',json_extract(c.payload,'$.discoveryOnly'),0))`

export function toUtcDay(now = Date.now()): string {
	return new Date(now).toISOString().slice(0, 10)
}

export class AdmissionError extends Error {
	constructor(
		readonly status: 400 | 403 | 413 | 429 | 503,
		message: string,
		readonly cap?: "visitorHits" | "budgetHits",
	) {
		super(message)
	}
}
export function migrateAdmissions(database: Database): void {
	// Retain legacy reports without manufacturing cache or billing evidence.
	database.transaction(() =>
		database.exec(`
		CREATE TABLE admissions(id TEXT PRIMARY KEY, cacheKey TEXT, revision TEXT, visitor TEXT, network TEXT, day TEXT,
			settings TEXT NOT NULL, hold INTEGER NOT NULL, settled INTEGER, settledDay TEXT, model INTEGER, sandbox INTEGER);
		UPDATE inspections SET state='interrupted',message='Admission rules changed. Please submit this repository again.' WHERE state='queued';
		CREATE INDEX admission_cache ON admissions(cacheKey);
		CREATE INDEX admission_budget ON admissions(day,settledDay);
		CREATE TABLE launch_counts(day TEXT, kind TEXT, count INTEGER, PRIMARY KEY(day,kind));
		CREATE TABLE foreign_views(visitor TEXT PRIMARY KEY, day TEXT, firstSeen INTEGER);
		CREATE TABLE shared_reports(id TEXT PRIMARY KEY, day TEXT);
		PRAGMA user_version=3;
	`),
	)()
}
export class AdmissionLedger {
	constructor(private readonly database: Database) {
		// Index outstanding holds and settled days independently, including on existing volumes.
		database.exec(
			"CREATE INDEX IF NOT EXISTS admission_unsettled ON admissions(settled,hold) WHERE settled IS NULL; CREATE INDEX IF NOT EXISTS admission_settlement ON admissions(settledDay,settled); CREATE TABLE IF NOT EXISTS joined_inspections(id TEXT PRIMARY KEY);",
		)
	}
	count(kind: string, day: string): void {
		this.database
			.query("INSERT INTO launch_counts VALUES(?,?,1) ON CONFLICT(day,kind) DO UPDATE SET count=count+1")
			.run(day, kind)
	}

	// Associate queued work with the release that will execute it.
	updateQueuedRelease(libraryVersion: string, releaseRevision: string): void {
		this.database
			.query(`UPDATE admissions SET cacheKey=json_set(cacheKey,'$[2]',?,'$[3]',?,'$[4]',json_extract(settings,'$.maxUpgrades'))
				WHERE id IN (SELECT id FROM inspections WHERE state='queued') AND json_valid(cacheKey)`)
			.run(libraryVersion, releaseRevision)
	}

	// Include a live claim when joining an identical submission.
	reuse(key: string, day: string): { id: string; reused: true } | null {
		const id = this.cache(key)
		if (!id) {
			return null
		}
		this.count("cache", day)

		// record that another submission follows this inspection
		this.database.query("INSERT OR IGNORE INTO joined_inspections VALUES(?)").run(id)
		return { id, reused: true }
	}

	// match the visitor who started an inspection nobody else submitted
	isOnlySubmitter(id: string, visitor: string): boolean {
		return (
			this.database
				.query("SELECT 1 FROM admissions WHERE id=? AND visitor=? AND id NOT IN (SELECT id FROM joined_inspections)")
				.get(id, visitor) !== null
		)
	}

	// start fresh work for later submissions of the same inspection
	preventReuse(id: string): void {
		this.database.query("UPDATE admissions SET cacheKey=NULL WHERE id=?").run(id)
	}

	handleRejection(input: { key: string; day: string; error: unknown }): { id: string; reused: true } {
		const { error, day, key } = input

		// Join work admitted while the visitor was verifying, even if limits have changed.
		if (error instanceof AdmissionError) {
			const joined = this.reuse(key, day)
			if (joined) {
				return joined
			}

			// Record a cap hit outside the rejected transaction only for a cache miss.
			if (error.cap) {
				this.count(error.cap, day)
			}
		}
		throw error
	}

	private cache(key: string): string | undefined {
		return this.database
			.query<{ id: string }, [string]>(`SELECT id FROM admissions JOIN inspections USING(id)
			WHERE cacheKey=? AND state IN ('queued','running','complete')
			AND (state!='complete' OR CASE WHEN json_valid(cacheKey) THEN json_extract(cacheKey,'$[5]') IS NOT 'menu' ELSE 1 END
			OR updated >= datetime('now','-1 hour')) LIMIT 1`)
			.get(key)?.id
	}

	// Carry unsettled holds across UTC budget windows.
	liability(day: string): number {
		return (
			this.database
				.query<{ total: number }, [string]>(`SELECT coalesce(sum(coalesce(settled,hold)),0) total FROM admissions
			WHERE settled IS NULL OR settledDay=?`)
				.get(day)?.total ?? 0
		)
	}

	// Count the stricter of the browser and network quotas.
	countRemainingInspections({ visitor, network }: Visitor, limits: LaunchLimits, day: string): number {
		const counts = this.database
			.query<{ v: number; n: number }, [string, string, string]>(
				"SELECT count(*) FILTER (WHERE visitor=?) v,count(*) FILTER (WHERE network=?) n FROM admissions WHERE day=?",
			)
			.get(visitor, network, day)
		return Math.max(0, limits.dailyVisitorInspections - Math.max(counts?.v ?? 0, counts?.n ?? 0))
	}

	// Enforce the visitor quota and the shared daily budget.
	checkAllowance(identity: Visitor, limits: LaunchLimits, day: string): void {
		if (this.countRemainingInspections(identity, limits, day) === 0) {
			throw new AdmissionError(429, "Your daily inspection allowance is used. It resets at 00:00 UTC.", "visitorHits")
		}

		// Preserve prior-day unsettled liabilities across the UTC boundary.
		const hold = Math.ceil(limits.maxCostUsd * 1e6)
		if (hold <= 0 || this.liability(day) + hold > limits.dailyMicros) {
			throw new AdmissionError(
				429,
				"The daily inspection budget is reserved or used. It resets at 00:00 UTC. Run Health Code in CI with your Runta account.",
				"budgetHits",
			)
		}
	}

	admit(input: {
		key: string
		head: RepositoryHead
		limits: LaunchLimits
		identity: Visitor
		enqueue: () => string
		now: number
	}): { id: string; reused: boolean } {
		// Attribute a new inspection to its admission day.
		const { key, head, limits, identity, enqueue, now } = input
		const day = toUtcDay(now)

		// Serialize the cache recheck, both quota buckets and the spend reservation.
		return this.database
			.transaction(() => {
				const cached = this.reuse(key, day)
				if (cached) {
					return cached
				}

				// Debit both pseudonymous counters only for newly accepted work.
				const { visitor, network } = identity
				this.checkAllowance(identity, limits, day)
				const hold = Math.ceil(limits.maxCostUsd * 1e6)
				const id = enqueue()
				this.database
					.query(
						"INSERT INTO admissions(id,cacheKey,revision,visitor,network,day,settings,hold) VALUES(?,?,?,?,?,?,?,?)",
					)
					.run(id, key, head.revision, visitor, network, day, JSON.stringify(limits), hold)
				this.count("starts", day)

				// Attribute at most one conversion to the viewer's original cohort.
				const cohort = this.database
					.query<{ day: string; firstSeen: number }, [string]>("SELECT * FROM foreign_views WHERE visitor=?")
					.get(visitor)
				if (cohort && now - cohort.firstSeen < 7 * 86400000 && cohort.firstSeen >= 0) {
					this.count("converted", cohort.day)
					this.database.query("UPDATE foreign_views SET firstSeen=-1 WHERE visitor=?").run(visitor)
				}

				return { id, reused: false }
			})
			.immediate()
	}

	// Release the hold when verification stops before paid work.
	release(id: string): void {
		this.database
			.query("UPDATE admissions SET settled=0, settledDay=date('now'),model=0,sandbox=0 WHERE id=? AND settled IS NULL")
			.run(id)
	}
	closeInterrupted(before = Date.now()): void {
		// Charge the reserved maximum once inventory confirms all prior allocations are gone.
		this.database
			.query(
				"UPDATE admissions SET settled=hold,settledDay=date('now') WHERE settled IS NULL AND id IN(SELECT id FROM inspections WHERE state IN ('interrupted','stopped','failed') AND unixepoch(updated)*1000<=?)",
			)
			.run(before)
	}
	tightenQueued(maxCostUsd: number): void {
		// Lower an unstarted reservation when the operator lowers its ceiling.
		if (maxCostUsd <= 0) {
			return
		}
		this.database
			.query("UPDATE admissions SET hold=min(hold,?) WHERE id IN(SELECT id FROM inspections WHERE state='queued')")
			.run(Math.ceil(maxCostUsd * 1e6))
	}

	workerLimits(id: string, current: LaunchLimits): LaunchLimits {
		const row = this.database
			.query<{ settings: string; hold: number }, [string]>("SELECT settings,hold FROM admissions WHERE id=?")
			.get(id)
		if (!row) {
			throw new Error("Missing durable launch reservation")
		}

		// Apply only the budget still reserved for this queued inspection.
		const saved: LaunchLimits = JSON.parse(row.settings)
		return {
			...current,
			maxCostUsd: Math.min(saved.maxCostUsd, current.maxCostUsd, row.hold / 1e6),
			repairUsd: Math.min(saved.repairUsd, current.repairUsd),
			adoptionUsd: Math.min(saved.adoptionUsd, current.adoptionUsd),
			maxUpgrades: Math.min(saved.maxUpgrades, current.maxUpgrades),
		}
	}
	canDispatch(dailyMicros: number): boolean {
		const row = this.database
			.query<{ owed: number; next: number | null }, []>(`SELECT
			(SELECT coalesce(sum(coalesce(settled,hold)),0) FROM admissions JOIN inspections USING(id) WHERE state!='queued' AND (settled IS NULL OR settledDay=date('now'))) owed,
			(SELECT hold FROM admissions JOIN inspections i USING(id) WHERE state='queued' ORDER BY i.rowid LIMIT 1) next`)
			.get()
		return !!row && row.next !== null && row.next > 0 && row.owed + row.next <= dailyMicros
	}
	settle(
		id: string,
		usage?: {
			totalUpperBoundUsd?: number
			modelCostUsd: number
			modelReservedUsd: number
			runtimes: { upperBoundUsd: number }[]
		},
	): void {
		if (!usage || usage.totalUpperBoundUsd === undefined) {
			return
		}
		const money = [
			usage.totalUpperBoundUsd,
			usage.modelCostUsd,
			usage.modelReservedUsd,
			...usage.runtimes.map((item) => item.upperBoundUsd),
		]
		if (money.some((value) => !Number.isFinite(value) || value < 0)) {
			return
		}

		// Store a conservative upper bound separately from measured model charges.
		this.database
			.query("UPDATE admissions SET settled=?,settledDay=date('now'),model=?,sandbox=? WHERE id=? AND settled IS NULL")
			.run(
				Math.ceil(usage.totalUpperBoundUsd * 1e6),
				Math.ceil(usage.modelCostUsd * 1e6),
				Math.ceil(usage.runtimes.reduce((sum, item) => sum + item.upperBoundUsd, 0) * 1e6),
				id,
			)
	}
	view(id: string, visitor: string, now = Date.now()): void {
		const day = toUtcDay(now)
		this.database
			.transaction(() => {
				const author = this.database
					.query<{ visitor: string; completed: string }, [string]>(
						`SELECT visitor,date(updated) completed FROM admissions JOIN inspections USING(id) WHERE id=? AND state='complete' AND ${shareableReport}`,
					)
					.get(id)
				if (!author?.visitor || author.visitor === visitor) {
					return
				}

				// Count a shared report in its completion cohort and a viewer on first contact.
				if (this.database.query("INSERT OR IGNORE INTO shared_reports VALUES(?,?)").run(id, author.completed).changes) {
					this.count("shared", author.completed)
				}

				// Deduplicate the viewer across all eligible report visits.
				if (this.database.query("INSERT OR IGNORE INTO foreign_views VALUES(?,?,?)").run(visitor, day, now).changes) {
					this.count("viewers", day)
				}
			})
			.immediate()
	}
	prune(): void {
		// Drop network digests when quotas expire and keep attribution for 30 days.
		this.database.exec(
			"UPDATE admissions SET network=NULL WHERE network IS NOT NULL AND day<date('now'); UPDATE admissions SET visitor=NULL WHERE visitor IS NOT NULL AND day<date('now','-30 days'); DELETE FROM foreign_views WHERE day<date('now','-30 days')",
		)
	}
	daily(): DailyActivity[] {
		return this.database
			.query<
				DailyActivity,
				[]
			>(`WITH days AS (SELECT date('now') day UNION SELECT day FROM launch_counts UNION SELECT day FROM admissions UNION SELECT settledDay FROM admissions WHERE settledDay IS NOT NULL UNION SELECT date(updated) FROM admissions JOIN inspections USING(id) WHERE state='complete')
		SELECT day,(SELECT count(*) FROM admissions JOIN inspections USING(id) WHERE state='complete' AND date(updated)=d.day AND ${shareableReport}) completed,
		(SELECT json_group_object(kind,count) FROM launch_counts WHERE day=d.day) counts,
		(SELECT coalesce(sum(model),0) FROM admissions WHERE settledDay=d.day) modelMicros,
		(SELECT coalesce(sum(sandbox),0) FROM admissions WHERE settledDay=d.day) sandboxUpperMicros,
		(SELECT coalesce(sum(settled),0) FROM admissions WHERE settledDay=d.day) settledUpperMicros,
		(SELECT coalesce(sum(hold),0) FROM admissions WHERE day=d.day AND settled IS NULL) pendingMicros FROM days d ORDER BY day DESC LIMIT 31`)
			.all()
	}
}
