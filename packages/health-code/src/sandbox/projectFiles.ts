import { checkOperation } from "../collectEvents.ts"
import { InspectionError, type Operation } from "../contracts.ts"
import { guestArguments } from "./executeGuest.ts"
import { checked, type Runtime } from "./requestRuntime.ts"

// Verify the opened descriptors so renaming a symlink cannot redirect a checked write.
const projectFile = [
	`import os, stat, sys
root, mode, path = sys.argv[1:]
def inside(fd):
    target = os.readlink("/proc/self/fd/" + str(fd))
    if os.path.commonpath([root, target]) != root:
        raise ValueError("File is outside project")`,

	// A new entry can only be created inside the directory we just verified.
	`parent, name = os.path.split(path)
directory = os.open(parent, os.O_RDONLY | os.O_DIRECTORY)
inside(directory)
flags = os.O_NONBLOCK | (os.O_RDONLY if mode == "read" else os.O_WRONLY)
try:
    fd = os.open(name, flags, dir_fd=directory)`,

	// Exclusive creation refuses a dangling link or a newly occupied name.
	`except FileNotFoundError:
    if mode == "read":
        raise
    fd = os.open(name, flags | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o666, dir_fd=directory)
inside(fd)
if not stat.S_ISREG(os.fstat(fd).st_mode):
    raise ValueError("Expected a regular file")`,

	// Truncate only the verified descriptor. Reading one extra byte preserves truncation detection.
	`if mode == "read":
    with os.fdopen(fd, "rb") as source:
        sys.stdout.buffer.write(source.read(65537))
else:
    with os.fdopen(fd, "wb") as destination:
        destination.truncate(0)
        destination.write(sys.stdin.buffer.read(65536))`,
].join("\n")

/**
 * Reads a bounded project file through the unprivileged guest boundary.
 */
export function readProjectFile({
	runtime,
	path,
	operation,
}: {
	runtime: Runtime
	path: string
	operation: Operation
}): Promise<string> {
	return checked(
		runtime,
		guestArguments(
			{
				argv: ["/usr/bin/python3", "-I", "-c", projectFile, "/project", "read", validatedPath(path)],
				timeoutMs: operation.timeoutMs,
			},
			undefined,
		),
		operation,
		true,
	)
}

/**
 * Bounds file writes before passing contents on stdin to the guest.
 */
export async function writeProjectFile({
	runtime,
	path,
	contents,
	operation,
}: {
	runtime: Runtime
	path: string
	contents: string
	operation: Operation
}): Promise<void> {
	// validate the write target and bound its contents
	const target = validatedPath(path)
	if (Buffer.byteLength(contents) > 65536) {
		throw new InspectionError("input-limit", "File exceeds input limit")
	}
	checkOperation(operation.signal)
	const result = await runtime.exec(
		guestArguments(
			{
				argv: ["/usr/bin/python3", "-I", "-c", projectFile, "/project", "write", target],
				timeoutMs: operation.timeoutMs,
			},
			undefined,
		),
		{ stdin: contents, timeoutSecs: Math.max(1, Math.ceil(operation.timeoutMs / 1000)) },
	)
	if (result.exitCode !== 0) {
		throw new InspectionError("write-failed", "Could not write project file")
	}
}

function validatedPath(path: string): string {
	// constrain file operations to relative paths beneath the guest project
	if (
		!path ||
		path.startsWith("/") ||
		path.split("/").some((part) => !part || part === "." || part === "..") ||
		path.includes("\0")
	) {
		throw new InspectionError("invalid-path", "Expected a relative project file")
	}

	// anchor the validated path inside the project mount
	return `/project/${path}`
}
