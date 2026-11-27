import { readFile } from "node:fs/promises"
import { createFakeGithub, type FakeGithub } from "health-code"
import { inspectionFixtureUrl, recordedProjectsUrl } from "./inspectionSettings.ts"

const projectFiles: Record<string, string[]> = {
	npm: ["package.json", "package-lock.json"],
	"bun-binary": ["package.json", "bun.lockb.base64"],
}

/**
 * Serves a recorded project and its registry versions the way GitHub and npm would, at the recorded commit.
 */
export async function createPublicProject(
	versions: Record<string, object> = { "1.2.0": {}, "1.3.0": {} },
	project: keyof typeof projectFiles = "npm",
): Promise<FakeGithub> {
	// read the committed files, decoding the binary lockfile that is stored as base64
	const files = new Map<string, string | Uint8Array>()
	for (const name of projectFiles[project] ?? []) {
		const text = await readFile(new URL(`${project}/${name}`, recordedProjectsUrl), "utf8")
		const isEncoded = name.endsWith(".base64")
		files.set(isEncoded ? name.slice(0, -".base64".length) : name, isEncoded ? Buffer.from(text, "base64") : text)
	}

	// use the commit the recorded sandbox reports
	const { commit } = JSON.parse(await readFile(inspectionFixtureUrl, "utf8")) as { commit: string }
	return createFakeGithub({
		repositories: { "example/project": { files, commit } },
		versions,
	})
}
