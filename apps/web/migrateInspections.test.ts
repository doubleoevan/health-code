import { Database } from "bun:sqlite"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { InspectionStore } from "./storeInspections.ts"

test("an online pre-migration backup restores a legacy report and its permanent patch", () => {
	const folder = mkdtempSync(join(tmpdir(), "health-code-migration-"))
	const path = join(folder, "cards.sqlite")
	const bytes = Buffer.from("archived patch bytes")
	const digest = createHash("sha256").update(bytes).digest("hex")
	const report = {
		version: 1,
		repository: { url: "https://github.com/example/project", commit: "a".repeat(40) },
		upgrades: [],
	}
	try {
		// Recreate the version-two schema with a report previously shared through the site.
		const previous = new Database(path, { create: true })
		previous.exec(`PRAGMA journal_mode=WAL; PRAGMA user_version=2;
			CREATE TABLE inspections(id TEXT PRIMARY KEY,repositoryUrl TEXT,state TEXT,message TEXT,report TEXT,libraryId TEXT,created TEXT,updated TEXT);
			CREATE TABLE events(id TEXT,sequence INTEGER,payload TEXT,PRIMARY KEY(id,sequence));
			CREATE TABLE patches(digest TEXT PRIMARY KEY,bytes BLOB);
			CREATE TABLE source_reports(id TEXT PRIMARY KEY,payload TEXT);`)
		previous
			.query(
				"INSERT INTO inspections(id,repositoryUrl,state,report,updated) VALUES('legacy',?,'complete',?,CURRENT_TIMESTAMP)",
			)
			.run(report.repository.url, JSON.stringify(report))
		previous.query("INSERT INTO patches VALUES(?,?)").run(digest, bytes)
		// Exercise the on-disk upgrade with committed changes still present in the WAL.
		const migrated = new InspectionStore(path)
		previous.close()
		assert.deepEqual(migrated.snapshot("legacy")?.card, report)
		assert.deepEqual(Buffer.from(migrated.patch(digest) ?? []), bytes)
		migrated.database.close()
		// Start a fresh worker directly on the backup and re-open the same evidence.
		const backup = readdirSync(folder).find((name) => name.endsWith(".backup"))
		assert.ok(backup)
		const restored = new InspectionStore(join(folder, backup))
		assert.deepEqual(restored.snapshot("legacy")?.card, report)
		assert.equal(
			createHash("sha256")
				.update(restored.patch(digest) ?? new Uint8Array())
				.digest("hex"),
			digest,
		)
		restored.database.close()
	} finally {
		rmSync(folder, { recursive: true, force: true })
	}
})
