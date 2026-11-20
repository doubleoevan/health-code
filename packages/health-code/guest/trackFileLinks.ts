import { posix } from "node:path"

// Initial links and links affected by moves have an unknown target.
export type FileLinks = Map<string, string | undefined>

function containsPath(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}/`)
}

export function isProjectPath(path: string): boolean {
	return containsPath("/project", posix.normalize(path))
}

function staysInProject(path: string, links: FileLinks): boolean {
	// Resolve each component before processing a later parent traversal.
	const remaining = path.split("/").reverse()
	let directory = "/"
	let followed = 0
	while (remaining.length) {
		const part = remaining.pop()
		if (!part || part === ".") {
			continue
		}
		directory = posix.join(directory, part)
		if (!isProjectPath(directory)) {
			return false
		}
		if (!links.has(directory)) {
			continue
		}

		// Expand only recorded targets and bound cycles.
		const target = links.get(directory)
		followed++
		if (!target || followed > 40) {
			return false
		}
		directory = target.startsWith("/") ? "/" : posix.dirname(directory)
		remaining.push(...target.split("/").reverse())
	}
	return isProjectPath(directory)
}

function hasLinkedParent(path: string, links: FileLinks): boolean {
	let parent = posix.dirname(path)
	while (parent !== "/") {
		if (links.has(parent)) {
			return true
		}
		parent = posix.dirname(parent)
	}
	return false
}

type LinkChange = { call: string; line: string; paths: string[]; links: FileLinks }

function recordLinkChange(change: LinkChange): void {
	const {
		call,
		line,
		paths: [first],
		links,
	} = change
	if (!first) {
		return
	}

	// Learn the target only from a fully decoded, successful symlink call.
	if (call.startsWith("symlink")) {
		const target = line.match(/^symlink(?:at)?\("([^"\\]*)",/)?.[1]
		links.set(first, links.has(first) ? undefined : target)
		return
	}
	if (call.startsWith("unlink") && links.has(first)) {
		links.set(first, undefined)
	}
	if (/^(?:rename|link)/.test(call)) {
		invalidateMovedLinks(change)
	}
}

function invalidateMovedLinks({ call, line, paths: [first, second], links }: LinkChange): void {
	if (!first || !second) {
		return
	}
	// Invalidate targets when their names or containing directories move.
	const rename = call.startsWith("rename")
	const exchange = line.includes("RENAME_EXCHANGE")
	for (const link of [...links.keys()]) {
		if (containsPath(first, link)) {
			links.set(second + link.slice(first.length), undefined)
			if (rename) {
				links.set(link, undefined)
			}
		}
		if (rename && containsPath(second, link)) {
			links.set(link, undefined)
			if (exchange) {
				links.set(first + link.slice(second.length), undefined)
			}
		}
	}
}

/** Tracks observed link targets and checks which path operations stay attributable. */
export function trackFileLinks(options: LinkChange): boolean {
	const { call, links } = options
	const paths = options.paths.map((path) => posix.normalize(path))
	const followsLink = /^(?:chmod|chown|truncate|utime|fchmodat|fchownat)/.test(call)
	const complete = paths.every((path) => {
		if (!hasLinkedParent(path, links) && !(followsLink && links.has(path))) {
			return true
		}
		return followsLink && staysInProject(path, links)
	})

	recordLinkChange({ ...options, paths })
	return complete
}
