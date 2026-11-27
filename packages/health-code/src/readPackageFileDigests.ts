import { createHash } from "node:crypto"
import { InspectionError } from "./contracts.ts"
import { type PackageFile, packageFiles, readPackageFile } from "./readPackageFile.ts"
import { type PromptName, readTemplate } from "./readPrompt.ts"

export type PackageFileDigest = { path: PackageFile; sha256: string }

/**
 * Reads every package file, validates the prompt templates and returns each file's SHA-256 digest.
 */
export function readPackageFileDigests(read: (path: PackageFile) => Buffer = readPackageFile): PackageFileDigest[] {
	return packageFiles.map((path) => {
		const contents = readContents(read, path)

		// reject an empty file and a prompt template the inspection would refuse
		if (!contents.length || !isValidContents(path, contents)) {
			throw new InspectionError("package-files", `The health-code package has an invalid ${path}. ${reinstall}`)
		}
		return { path, sha256: createHash("sha256").update(contents).digest("hex") }
	})
}

const reinstall = "Install the package again or download the executable again."

// name the missing file instead of the file system error
function readContents(read: (path: PackageFile) => Buffer, path: PackageFile): Buffer {
	try {
		return read(path)
	} catch {
		throw new InspectionError("package-files", `The health-code package is missing ${path}. ${reinstall}`)
	}
}

// validate prompt templates through the same reader inspections use
function isValidContents(path: PackageFile, contents: Buffer): boolean {
	if (!path.startsWith("prompts/")) {
		return true
	}

	// read the template name from its file name
	const name = path.slice("prompts/".length, -".md".length) as PromptName | "investigateInspection"
	try {
		readTemplate(name, contents.toString("utf8"))
		return true
	} catch {
		return false
	}
}
