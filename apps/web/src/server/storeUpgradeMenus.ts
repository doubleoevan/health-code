import type { Database } from "bun:sqlite"
import { upgradeMenuRetryMessage } from "./buildUpgradeMenu.ts"
import { countVisitorRows, upgradeMenuReuseWindow, type Visitor } from "./recordAdmissions.ts"

export type StartUpgradeMenuOptions = {
	makeId: () => string
	repositoryUrl: string
	revision?: string

	// the cache key and the visitor a fresh build counts against
	cacheKey?: string
	identity?: Visitor
	day: string
}

const interruptedMessage = `This upgrade menu was interrupted when the server restarted. ${upgradeMenuRetryMessage}`

/**
 * Records each upgrade menu's cache key and the visitor its build counts against.
 */
export class UpgradeMenuLedger {
	constructor(private readonly database: Database) {
		database.exec(
			"CREATE TABLE IF NOT EXISTS upgrade_menus(id TEXT PRIMARY KEY, cacheKey TEXT UNIQUE, visitor TEXT, network TEXT, day TEXT)",
		)
		database.exec("CREATE INDEX IF NOT EXISTS upgrade_menus_day ON upgrade_menus(day)")
	}

	// find a running build or a complete menu from the last hour for the same repository and commit
	reuse(cacheKey: string): string | undefined {
		return this.database
			.query<{ id: string }, [string]>(`SELECT m.id FROM upgrade_menus m JOIN inspections i USING(id)
			WHERE m.cacheKey=? AND (i.state='running' OR (i.state='complete' AND ${upgradeMenuReuseWindow}))`)
			.get(cacheKey)?.id
	}

	// start one build per cache key and hand a simultaneous submission the build that won
	start({ makeId, repositoryUrl, revision, cacheKey, identity, day }: StartUpgradeMenuOptions): {
		id: string
		reused: boolean
	} {
		return this.database
			.transaction(() => {
				// join the running build or the complete menu for this cache key
				const existingUpgradeMenuId = cacheKey === undefined ? undefined : this.reuse(cacheKey)
				if (existingUpgradeMenuId) {
					return { id: existingUpgradeMenuId, reused: true }
				}

				// clear an expired or failed menu's cache key before the new build takes it
				if (cacheKey !== undefined) {
					this.database.query("UPDATE upgrade_menus SET cacheKey=NULL WHERE cacheKey=?").run(cacheKey)
				}
				const id = makeId()
				const choice = JSON.stringify({ mode: "listUpgrades", ...(revision && { revision }) })

				// insert the row as running. a running row stays out of the inspection queue
				this.database
					.query("INSERT INTO inspections(id,repositoryUrl,state) VALUES(?,?,'running')")
					.run(id, repositoryUrl)
				this.database.query("INSERT INTO inspection_choices VALUES(?,?)").run(id, choice)

				// record the cache key and the visitor this fresh build counts against
				this.database
					.query("INSERT INTO upgrade_menus VALUES(?,?,?,?,?)")
					.run(id, cacheKey ?? null, identity?.visitor ?? null, identity?.network ?? null, day)
				return { id, reused: false }
			})
			.immediate()
	}

	// let the next submission build again after an incomplete or failed menu
	release(id: string): void {
		this.database.query("UPDATE upgrade_menus SET cacheKey=NULL WHERE id=?").run(id)
	}

	isUpgradeMenu(id: string): boolean {
		return this.database.query("SELECT 1 FROM upgrade_menus WHERE id=?").get(id) !== null
	}

	// return the larger of the visitor and network counts for the day
	countFreshUpgradeMenus(identity: Visitor, day: string): number {
		return countVisitorRows({ database: this.database, table: "upgrade_menus", identity, day })
	}

	// fail the builds a previous process left running
	interrupt(): void {
		this.database.transaction(() => {
			this.database
				.query(`UPDATE inspections SET state='failed',message=?,updated=CURRENT_TIMESTAMP
				WHERE state='running' AND id IN (SELECT id FROM upgrade_menus)`)
				.run(interruptedMessage)
			this.database.exec(
				"UPDATE upgrade_menus SET cacheKey=NULL WHERE id IN (SELECT id FROM inspections WHERE state='failed')",
			)
		})()
	}

	// drop visitor and network digests once their day has passed
	prune(): void {
		this.database.exec(
			"UPDATE upgrade_menus SET visitor=NULL,network=NULL WHERE visitor IS NOT NULL AND day<date('now')",
		)
	}
}
