import { parse as parseClassicLock } from "@yarnpkg/lockfile"
import type { PackageManager } from "../contracts.ts"
import { parseYaml } from "../parseYaml.ts"
import { readOwnProperty } from "../readOwnProperty.ts"

// the locked version of one dependency, looked up by workspace directory, name and declared range
type VersionLookup = (directory: string, name: string, range: string) => unknown

type VersionLookupOptions = {
	manager: PackageManager
	lockfileName: string
	lockfileText: string

	// the manifest sections a pnpm importer repeats
	sections: readonly string[]
}

// the bytes that structure a text bun lockfile
const quoteByte = 0x22
const backslashByte = 0x5c
const commaByte = 0x2c
const slashByte = 0x2f
const starByte = 0x2a
const newlineByte = 0x0a

// the bytes that replace or end a trailing comma
const spaceByte = 0x20
const closingBraceByte = 0x7d
const closingBracketByte = 0x5d
const maxCommaLookahead = 256

/**
 * Reads the lookup for the locked versions in the text of the package manager's lockfile.
 */
export function readVersionLookup({
	manager,
	lockfileName,
	lockfileText,
	sections,
}: VersionLookupOptions): VersionLookup {
	// read each lockfile format through its lookup
	if (manager === "npm") {
		return toNpmLookup(JSON.parse(lockfileText))
	}
	if (manager === "pnpm") {
		return toPnpmLookup(parseYaml(toImportersText(lockfileText)), sections)
	}

	// read a text bun lockfile as json and a decoded binary one as yarn descriptors
	if (lockfileName === "bun.lock") {
		return toBunLookup(JSON.parse(dropTrailingCommas(lockfileText)))
	}
	return toDescriptorLookup(lockfileText)
}

// resolve npm versions through workspace and root lock entries
function toNpmLookup(lock: unknown): VersionLookup {
	const packages = readOwnProperty(lock, "packages")
	const dependencies = readOwnProperty(lock, "dependencies")
	return (directory, name) => {
		// prefer the entry nearest the workspace, as node resolves through each ancestor directory
		const ancestors = directory === "." ? [] : directory.split("/")
		for (let depth = ancestors.length; depth > 0; depth--) {
			const entry = readOwnProperty(packages, `${ancestors.slice(0, depth).join("/")}/node_modules/${name}`)
			if (entry !== undefined) {
				return readOwnProperty(entry, "version")
			}
		}

		// fall back to the root entry, then to an older lockfile's dependency tree
		return readOwnProperty(
			readOwnProperty(packages, `node_modules/${name}`) ?? readOwnProperty(dependencies, name),
			"version",
		)
	}
}

// keep only the importers block of a pnpm lockfile, which holds every version the lookup reads
function toImportersText(lockfileText: string): string {
	const start = lockfileText.search(/^importers:/m)
	if (start === -1) {
		return lockfileText
	}

	// end the block at the next line that starts a top-level key
	const bodyStart = lockfileText.indexOf("\n", start) + 1
	const blockLength = bodyStart === 0 ? -1 : lockfileText.slice(bodyStart).search(/^[^\s#]/m)
	return blockLength === -1 ? lockfileText.slice(start) : lockfileText.slice(start, bodyStart + blockLength)
}

// read the matching importer from the pnpm lockfile
function toPnpmLookup(lock: unknown, sections: readonly string[]): VersionLookup {
	const importers = readOwnProperty(lock, "importers")
	return (directory, name) => {
		const importer = readOwnProperty(importers, directory) ?? (directory === "." ? lock : undefined)
		for (const section of sections) {
			const lockedEntry = readOwnProperty(readOwnProperty(importer, section), name)

			// strip peer dependency qualifiers from the locked version
			if (lockedEntry) {
				return String(readOwnProperty(lockedEntry, "version") ?? lockedEntry).split("(")[0]
			}
		}
	}
}

// drop the trailing commas bun writes in its text lockfile
function dropTrailingCommas(text: string): string {
	// blank each trailing comma and comment in place, so the text is copied once however many it holds
	const bytes = Buffer.from(text)
	let isInString = false
	for (let index = 0; index < bytes.length; index++) {
		const byte = bytes[index]
		if (isInString) {
			// skip an escaped character and leave the string at its closing quote
			index += byte === backslashByte ? 1 : 0
			isInString = byte !== quoteByte
		} else if (byte === quoteByte) {
			// enter a string at its opening quote
			isInString = true
		} else if (byte === slashByte) {
			// blank a comment and continue after it
			index = blankComment(bytes, index)
		} else if (byte === commaByte && isBeforeClosingBracket(bytes, index + 1)) {
			bytes[index] = spaceByte
		}
	}
	return bytes.toString()
}

// blank a line or block comment that starts at a slash and return the index of its last byte
function blankComment(bytes: Buffer, start: number): number {
	const isLine = bytes[start + 1] === slashByte
	if (!isLine && bytes[start + 1] !== starByte) {
		return start
	}

	// end a line comment before its newline and a block comment after its closing slash
	const found = isLine ? bytes.indexOf(newlineByte, start) : bytes.indexOf("*/", start + 2)
	const end = found === -1 ? bytes.length : found + (isLine ? 0 : 2)
	bytes.fill(spaceByte, start, end)
	return end - 1
}

// check whether only whitespace separates a position from a closing bracket
function isBeforeClosingBracket(bytes: Buffer, start: number): boolean {
	// look a bounded distance ahead for the first byte that is not whitespace
	for (let index = start; index < Math.min(bytes.length, start + maxCommaLookahead); index++) {
		const byte = bytes[index] ?? 0
		if (byte > spaceByte) {
			return byte === closingBraceByte || byte === closingBracketByte
		}
	}
	return false
}

// resolve bun workspace package aliases before root packages
function toBunLookup(lock: unknown): VersionLookup {
	const workspaces = readOwnProperty(lock, "workspaces")
	const packages = readOwnProperty(lock, "packages")
	return (directory, name) => {
		// read the version after the package name in the first resolution field
		const workspaceName = readOwnProperty(readOwnProperty(workspaces, directory), "name")
		const entry = readOwnProperty(packages, `${workspaceName}/${name}`) ?? readOwnProperty(packages, name)
		const resolution: unknown = Array.isArray(entry) ? entry[0] : undefined
		return typeof resolution === "string" ? resolution.slice(name.length + 1) : undefined
	}
}

// match the requested descriptor in a yarn lockfile or a decoded bun lockfile
function toDescriptorLookup(lockfileText: string): VersionLookup {
	const lock: unknown = lockfileText.includes("__metadata:")
		? parseYaml(lockfileText)
		: parseClassicLock(lockfileText).object
	const lockedVersions = new Map<string, unknown>()
	for (const [key, entry] of Object.entries(typeof lock === "object" && lock !== null ? lock : {})) {
		for (const descriptor of key.split(", ")) {
			// keep the first entry that names a descriptor
			if (!lockedVersions.has(descriptor)) {
				lockedVersions.set(descriptor, readOwnProperty(entry, "version"))
			}
		}
	}
	return (_directory, name, range) =>
		lockedVersions.get(`${name}@${range}`) ?? lockedVersions.get(`${name}@npm:${range}`)
}
