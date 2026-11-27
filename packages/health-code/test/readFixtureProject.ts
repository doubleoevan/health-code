import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import type { FakeRepository } from "../src/upgrades/createFakeGithub.ts"
import {
	type LockedDependenciesOptions,
	listLockfileNames,
	selectWorkspaceDirectories,
} from "../src/upgrades/readLockedDependencies.ts"

const recorded = fileURLToPath(new URL("./fixtures/recorded/", import.meta.url))

// the recorded projects that hold a text lockfile
export const textFixtureNames = ["npm", "pnpm", "bun", "yarn", "yarn-modern"] as const

// the repository a fake GitHub serves as example/project, and the time the dated tests read as now
export const fakeRepositoryUrl = "https://github.com/example/project"
export const fixtureNow = Date.parse("2026-11-26T12:00:00Z")

type FixtureProject = LockedDependenciesOptions & { files: Map<string, string> }

/**
 * Reads a recorded project's files as strings.
 */
export function readFixtureProject(name: string): FixtureProject {
	// collect every recorded file by its path relative to the project root
	const root = join(recorded, name)
	const files = new Map<string, string>()
	for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (entry.isFile()) {
			const path = join(entry.parentPath, entry.name).slice(root.length + 1)
			files.set(path, readFileSync(join(root, path), "utf8"))
		}
	}

	// name the root lockfiles and the declared workspaces
	const lockfileNames = listLockfileNames((file) => files.has(file) || files.has(`${file}.base64`))
	const workspaceDirectories = selectWorkspaceDirectories({
		rootManifest: files.get("package.json") ?? "",
		pnpmWorkspace: files.get("pnpm-workspace.yaml"),
		filePaths: [...files.keys()],
	})
	return { files, lockfileNames, workspaceDirectories }
}

/**
 * Shapes a recorded project as a fake repository and decodes a binary lockfile that is stored as base64.
 */
export function toFakeRepository(name: string, overrides: Partial<FakeRepository> = {}): FakeRepository {
	const files = new Map<string, string | Uint8Array>()
	for (const [path, content] of readFixtureProject(name).files) {
		const isEncoded = path.endsWith(".base64")
		files.set(isEncoded ? path.slice(0, -".base64".length) : path, isEncoded ? Buffer.from(content, "base64") : content)
	}
	return { files, ...overrides }
}
