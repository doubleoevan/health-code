import { posix } from "node:path"
import { containsPath } from "./trackFileLinks.ts"

// Threads created with CLONE_FS use one directory object.
type Directory = { path: string | undefined; version: number; hasKnownParent: boolean; isFixedUnknown: boolean }
type SharedDirectory = "shared" | "copied" | "unknown"
type PendingCall = { text: string; directory: Directory; path: string | undefined; version: number; childPid?: string }

/**
 * Follows the working directory of each traced process from its inherited project directory.
 */
export class WorkingDirectories {
	isProcessReused = false
	private hasChanged = false
	private readonly directories = new Map<string, Directory>()
	private readonly unknownParents = new Set<Directory>()
	private readonly pending = new Map<string, PendingCall>()

	// children that started while several parents had an open call
	private readonly ambiguous = new Set<string>()

	/**
	 * Records one trace row and returns the directory that applied throughout its completed call.
	 */
	record(pid: string, text: string): string | undefined {
		if (text.startsWith("<... ")) {
			return this.finish(pid, text.replace(/^<\.\.\. \w+ resumed>/, ""))
		}

		// hold the starting directory until the call completes
		const isUnfinished = text.endsWith("<unfinished ...>")
		this.start(pid, isUnfinished ? text.replace(/\s*<unfinished \.\.\.>$/, "") : text)
		if (!isUnfinished) {
			return this.finish(pid, "")
		}

		// a rename can move a directory before its result is recorded
		if (text.startsWith("rename")) {
			this.invalidateMovedDirectories(text, this.pending.get(pid)?.path)
		}
		return undefined
	}

	private start(pid: string, text: string): void {
		const directory = this.directories.get(pid) ?? this.inherit(pid)
		const call: PendingCall = { text, directory, path: directory.path, version: directory.version }
		this.pending.set(pid, call)

		// treat the directory as unknown while a change can take effect
		if (/^(?:f?chdir|chroot|pivot_root|unshare|setns)\(/.test(text)) {
			this.hasChanged = true
			this.change(directory, undefined)
			this.invalidatePossibleSharers(directory)
			call.version = directory.version
		}
	}

	private finish(pid: string, rest: string): string | undefined {
		const call = this.pending.get(pid)
		this.pending.delete(pid)
		if (!call) {
			return undefined
		}

		// reject a directory that another thread changed during this call
		const line = call.text + rest
		const path = call.directory.version === call.version ? call.path : undefined

		// record new processes, directory changes and moved directories
		if (/^(?:clone3?|v?fork)\(/.test(line)) {
			this.recordChild(call, line, path)
		} else if (/^f?chdir\(/.test(line)) {
			this.recordChange(call, line, path)
		} else if (/^rename/.test(line) && / = 0$/.test(line)) {
			this.invalidateMovedDirectories(line, path)
		} else if (/^(?:chroot|pivot_root|unshare|setns)\(/.test(line) && / = 0$/.test(line)) {
			// a new root or namespace changes how later paths resolve
			call.directory.isFixedUnknown = true
		} else if (/^(?:chroot|pivot_root|unshare|setns)\(/.test(line) && path !== undefined) {
			this.change(call.directory, path)
		}
		return path
	}

	private recordChange(call: PendingCall, line: string, path: string | undefined): void {
		const { directory } = call

		// concurrent changes to a shared directory have no reliable order
		if (directory.version !== call.version) {
			this.change(directory, undefined)
			return
		}

		// restore the directory after a failed change
		if (!/ = 0$/.test(line)) {
			this.change(directory, path)
			return
		}

		// resolve the directory named by a path or descriptor
		const target = /^chdir\("([^"\\]*)"\)/.exec(line)?.[1]
		const descriptor = /^fchdir\(\d+<(\/[^>]*)>\)/.exec(line)?.[1]
		this.change(directory, descriptor ?? toChangedPath(target, path))
		this.invalidatePossibleSharers(directory)
	}

	// A process with an unknown parent may share its directory with any other process.
	private invalidatePossibleSharers(directory: Directory): void {
		const sharers = directory.hasKnownParent ? this.unknownParents : new Set(this.directories.values())
		for (const other of sharers) {
			if (other !== directory) {
				this.change(other, undefined)
			}
		}
	}

	private recordChild(call: PendingCall, line: string, path: string | undefined): void {
		const child = / = (\d+)$/.exec(line)?.[1]
		if (!child) {
			return
		}

		// a child can run before its parent's call returns
		if (call.childPid === child) {
			return
		}

		// record a reused process before remembering a new child
		const existingDirectory = this.directories.get(child)
		if (call.childPid || existingDirectory?.hasKnownParent) {
			this.isProcessReused ||= call.childPid !== undefined || !this.ambiguous.delete(child)
			return
		}

		// start the child in the directory of its parent
		if (!existingDirectory) {
			this.remember(child, this.toChild(call, line, path))
		}
	}

	private inherit(pid: string): Directory {
		const parents = [...this.pending.values()].filter(
			(call) => !call.childPid && /^(?:clone3?|v?fork)\(/.test(call.text),
		)
		const [parent] = parents
		let directory: Directory
		if (parent && parents.length === 1) {
			// bind the child to the only open process call
			parent.childPid = pid
			const path = parent.directory.version === parent.version ? parent.path : undefined
			directory = this.toChild(parent, parent.text, path)
		} else if (parents.length && parents.every((call) => toSharing(call.text) === "copied")) {
			// Any of these parents gives the child a private copy.
			this.ambiguous.add(pid)
			const paths = new Set(parents.map((call) => (call.directory.version === call.version ? call.path : undefined)))
			directory = toDirectory(paths.size === 1 ? [...paths][0] : undefined, true)
		} else {
			// Every process starts in the project until one of them changes directory.
			directory = toDirectory(this.hasChanged ? undefined : "/project", this.directories.size === 0)
		}
		this.remember(pid, directory)
		return directory
	}

	private remember(pid: string, directory: Directory): void {
		this.directories.set(pid, directory)
		if (!directory.hasKnownParent) {
			this.unknownParents.add(directory)
		}
	}

	private toChild(call: PendingCall, line: string, path: string | undefined): Directory {
		const sharing = toSharing(line)
		if (sharing === "copied") {
			const copy = toDirectory(path, call.directory.hasKnownParent)
			copy.isFixedUnknown = call.directory.isFixedUnknown
			return copy
		}

		// Unreadable flags leave both processes unattributable.
		if (sharing === "unknown") {
			this.change(call.directory, undefined)
			call.directory.isFixedUnknown = true
		}
		return call.directory
	}

	private invalidateMovedDirectories(line: string, path: string | undefined): void {
		const renamedPaths = [...line.matchAll(/(?:<([^>]+)>, )?"([^"]*)"/g)].slice(0, 2).map(([, base, name]) => {
			const root = base ?? path
			if (name?.startsWith("/")) {
				return posix.normalize(name)
			}
			return root && name !== undefined ? posix.resolve(root, name) : undefined
		})

		// an unknown renamed path can contain any directory
		for (const directory of new Set(this.directories.values())) {
			const current = directory.path
			const isAffected = renamedPaths.some(
				(root) => root === undefined || (current !== undefined && containsPath(root, current)),
			)
			if (isAffected) {
				this.change(directory, undefined)
			}
		}
	}

	private change(directory: Directory, path: string | undefined): void {
		directory.version++
		directory.path = directory.isFixedUnknown ? undefined : path
	}
}

function toDirectory(path: string | undefined, hasKnownParent: boolean): Directory {
	return { path, version: 0, hasKnownParent, isFixedUnknown: false }
}

// read whether a new process shares its parent's directory
function toSharing(line: string): SharedDirectory {
	if (/^v?fork\(/.test(line)) {
		return "copied"
	}

	// clone flags decide whether the directory is shared
	if (!/flags=/.test(line)) {
		return "unknown"
	}
	return /\bCLONE_FS\b/.test(line) ? "shared" : "copied"
}

function toChangedPath(target: string | undefined, directory: string | undefined): string | undefined {
	// A parent component can cross a symbolic link.
	if (target === undefined || target.split("/").includes("..")) {
		return undefined
	}
	if (target.startsWith("/")) {
		return posix.normalize(target)
	}
	return directory === undefined ? undefined : posix.resolve(directory, target)
}
