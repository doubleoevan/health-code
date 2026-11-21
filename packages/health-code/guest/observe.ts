import { readFileSync, rmSync, statSync } from "node:fs"
import { isIP } from "node:net"
import { posix } from "node:path"
import type { InstallationFinding, Observation } from "../src/contracts.ts"
import { type FileLinks, isProjectPath, trackFileLinks } from "./trackFileLinks.ts"

type InstallationObservations = { connections: Observation; files: Observation }
function markIncomplete(result: Observation, reason = "Incomplete installation observation"): void {
	result.complete = false
	result.reason ??= reason
}
// bound the number of distinct installation findings
function addFinding(result: Observation, finding: InstallationFinding): void {
	if (result.findings.length >= 256) {
		markIncomplete(result, "Finding limit reached")
		return
	}
	// coalesce repeated observations of the same action
	if (!result.findings.some((existing) => JSON.stringify(existing) === JSON.stringify(finding))) {
		result.findings.push(finding)
	}
}
type DnsHistory = Map<string, Map<string, number>>
// correlate dns answers with their original questions
function dnsAnswers(text: string): DnsHistory {
	const questions = new Map<string, string>()
	const answers: DnsHistory = new Map()
	// index outgoing queries by endpoints and request id
	for (const line of text.split("\n")) {
		const query = line.match(/ IP6? ([\w:.]+) > ([\w:.]+): (\d+)\+?[^?]*? (?:A|AAAA)\? ([\w.-]+)\./)
		if (query) {
			questions.set([query[1], query[2], query[3]].join("/"), (query[4] ?? "").toLowerCase())
			continue
		}
		// match replies using the reverse endpoint order
		const response = line.match(/ IP6? ([\w:.]+) > ([\w:.]+): (\d+)[*+ -]/)
		if (!response) {
			continue
		}
		const host = questions.get([response[2], response[1], response[3]].join("/"))
		if (!host) {
			continue
		}
		// associate the resolved addresses with the queried host
		recordAnswer(answers, host, line)
	}
	return answers
}
function recordAnswer(answers: DnsHistory, host: string, line: string): void {
	// extract ipv4 and ipv6 addresses from dns answers
	for (const match of line.matchAll(/\b(?:A|AAAA) ([\da-f:.]+)/gi)) {
		const address = match[1] ?? ""
		if (!isIP(address)) {
			continue
		}
		// retain the first resolution timestamp for each host
		const names = answers.get(address) ?? new Map<string, number>()
		const timestamp = Number.parseFloat(line)
		if (!names.has(host) && Number.isFinite(timestamp)) {
			names.set(host, timestamp)
		}
		answers.set(address, names)
	}
}
// attribute outgoing internet socket calls to prior dns answers
function network(line: string, hosts: DnsHistory, timestamp: number, allowed: string[], result: Observation): void {
	if (!/^(?:connect|sendto|sendmsg|sendmmsg)\(/.test(line) || !line.includes("AF_INET")) {
		return
	}
	// flag trace entries that omit the destination address
	const address = line.match(/(?:inet_addr\(|inet_pton\(AF_INET6, )"([^"]+)"/)?.[1]
	if (!address) {
		markIncomplete(result, "Socket address unavailable")
		return
	}
	// skip the guest resolver and loopback connections
	if (address === "10.0.2.3" && /sin_port=htons\(53\)/.test(line)) {
		return
	}
	if (address === "::1" || address.startsWith("127.")) {
		return
	}
	// consider only names resolved before the socket call
	const candidates = [...(hosts.get(address) ?? [])].filter(([, seen]) => seen <= timestamp).map(([host]) => host)
	if (candidates.length === 1 && candidates[0]) {
		if (!allowed.includes(candidates[0])) {
			addFinding(result, { kind: "connection", destination: candidates[0], outcome: "attempted" })
		}
		return
	}
	// accept ambiguous addresses only when all candidates are allowed
	if (candidates.length && candidates.every((host) => allowed.includes(host))) {
		return
	}
	markIncomplete(result, "Socket destination could not be attributed to DNS")
	addFinding(result, { kind: "connection", destination: address, outcome: "unknown" })
}
function mutationPaths({
	call,
	line,
	result,
	links,
	fixedDirectory,
}: {
	// describe the syscall and its directory context
	call: string
	line: string
	result: Observation
	links: FileLinks
	fixedDirectory?: string
}): string[] {
	// select the pathname arguments modified by this syscall
	const paths: string[] = []
	const quoted = [...line.matchAll(/(?:([\w-]+)<([^>]+)>(?:\(deleted\))?, )?"((?:[^"\\]|\\.)*)"/g)]
	const relevant = call.startsWith("symlink")
		? quoted.slice(-1)
		: /^(?:link|rename)/.test(call)
			? quoted.slice(0, 2)
			: quoted.slice(0, 1)
	// resolve each recorded mutation against its directory
	for (const item of relevant) {
		const path = item[3] ?? ""
		if (path.includes("\\") || path.split("/").includes("..")) {
			markIncomplete(result, "Filesystem path escaped or contained parent components")
		}
		// retain attributable targets and flag unresolved relative paths
		const resolved = mutationTarget({ item, path, fixedDirectory, line, call })
		if (resolved) {
			paths.push(resolved)
		} else {
			markIncomplete(result, `Relative filesystem change lacks a directory descriptor (${call})`)
		}
	}
	// update link history before classifying filesystem coverage
	if (!trackFileLinks({ call, line, paths, links })) {
		markIncomplete(
			result,
			`Could not resolve a filesystem change through a symbolic link (${call}: ${paths.map((path) => path.slice(0, 240)).join(", ")})`,
		)
	}
	return paths
}
function mutationTarget({
	path,
	item,
	fixedDirectory,
	line,
	call,
}: {
	// describe the evidence available for resolving a relative target
	path: string
	item: RegExpMatchArray
	fixedDirectory?: string
	line: string
	call: string
}): string | undefined {
	// prefer the absolute path or the decoded directory descriptor
	if (path.startsWith("/")) {
		return path
	} else if (item[2]?.startsWith("/")) {
		return posix.resolve(item[2], path)
	} else if (fixedDirectory && (!/(?:at|at2)$/.test(call) || /AT_FDCWD, $/.test(line.slice(0, item.index)))) {
		return posix.resolve(fixedDirectory, path)
	}
}
// locate the writable destination of a transfer or mapping
function transferTargets(line: string, call: string): string[] {
	const descriptors = [...line.matchAll(/\d+<([^>]+)>/g)]
	const target = call === "mmap" ? descriptors[0]?.[1] : descriptors[1]?.[1]
	if (target?.startsWith("/") && (call !== "mmap" || /PROT_WRITE.*MAP_SHARED/.test(line))) {
		return [target]
	}
	return []
}
// track mappings that could later gain write permission
type FileState = { links: FileLinks; sharedOutsideMapping: boolean }
function observeMappings(call: string, line: string, state: FileState, result: Observation): void {
	if (call === "mmap" && line.includes("MAP_SHARED") && !line.includes("PROT_WRITE")) {
		const descriptor = line.match(/\d+<([^>]+)>/)?.[1]
		// The guest mounts /usr read-only, so these mappings cannot write back to a system file.
		if (descriptor?.startsWith("/") && !descriptor.startsWith("/usr/") && !isProjectPath(descriptor)) {
			state.sharedOutsideMapping = true
		}
	}
	// flag untraceable changes to a shared mapping's permissions
	if (state.sharedOutsideMapping && /^(?:pkey_)?mprotect$/.test(call) && line.includes("PROT_WRITE")) {
		markIncomplete(result, "Could not attribute a writable memory protection change to a file")
	}
}
function descriptorTargets(line: string, result: Observation): string[] {
	// resolve the writable descriptor to its decoded path
	const target = line.match(/^\w+\(\d+<([^>]+)>/)?.[1]
	if (!target) {
		markIncomplete(result, "Writable file descriptor unavailable")
	}
	return target?.startsWith("/") ? [target] : []
}
function filesystem(line: string, result: Observation, state: FileState, fixedDirectory?: string): void {
	// inspect only successful filesystem calls
	if (!/\)\s+= (?:0x[\da-f]+|0|[1-9]\d*)(?:<[^>]*>)?$/.test(line)) {
		return
	}
	const call = line.slice(0, line.indexOf("("))
	let paths: string[] = []
	observeMappings(call, line, state, result)
	// select writes that operate on an existing descriptor
	if (
		[
			"write",
			"writev",
			"pwrite64",
			"pwritev",
			"pwritev2",
			"fchmod",
			"fchown",
			"ftruncate",
			"fallocate",
			"fsetxattr",
			"fremovexattr",
			"sendfile",
		].includes(call) ||
		/^utimensat\([^,]+, NULL, /.test(line)
	) {
		// decode the target according to the syscall family
		paths = descriptorTargets(line, result)
	} else if (["copy_file_range", "splice", "mmap"].includes(call)) {
		paths = transferTargets(line, call)
	} else if (/^(?:open|openat|openat2|creat)$/.test(call) && /O_CREAT|O_TRUNC|^creat\(/.test(line)) {
		const target = line.match(/ = \d+<([^>]+)>$/)?.[1]
		// retain the path returned by a successful open
		if (target) {
			paths = [target]
		} else {
			markIncomplete(result, "Created file descriptor unavailable")
		}
	} else if (
		/^(?:rename|unlink|rmdir|mkdir|f?chmod|f?chown|lchown|truncate|link|symlink|utime|mknod|l?setxattr|l?removexattr)/.test(
			call,
		)
	) {
		// resolve path-based operations through the link history
		paths = mutationPaths({ call, line, result, links: state.links, fixedDirectory })
	}
	for (const path of paths) {
		const normalized = posix.normalize(path)
		// record normalized writes outside the project and approved devices
		if (!isProjectPath(normalized) && !["/dev/null", "/dev/tty", "/dev/zero"].includes(normalized)) {
			addFinding(result, { kind: "write", path: normalized })
		}
	}
}
type TraceCall = { line: string; timestamp: number }
// reconstruct interrupted syscall records per process
function assembled(row: string, pending: Map<string, TraceCall>): TraceCall | undefined {
	const match = row.match(/^(\d+)\s+(?:(\d+\.\d+)\s+)?(.*)$/)
	if (!match) {
		return
	}
	// retain the process and the timestamp from its first entry
	const pid = match[1] ?? ""
	let line = match[3] ?? ""
	let timestamp = Number(match[2])
	if (line.endsWith("<unfinished ...>")) {
		pending.set(pid, { line: line.replace(/\s*<unfinished \.\.\.>$/, ""), timestamp })
		return
	}
	// join the resumed call with its saved beginning
	if (line.startsWith("<... ")) {
		const previous = pending.get(pid)
		timestamp = previous?.timestamp ?? Number.NaN
		line = (previous?.line ?? "") + line.replace(/^<\.\.\. \w+ resumed>/, "")
		pending.delete(pid)
	}
	// return the reconstructed syscall for attribution
	return { line, timestamp }
}
function recordDnsQueries(dns: string, allowed: string[], connections: Observation): void {
	// Preserve off-list DNS attempts even when the gateway supplies no address.
	for (const query of dns.split("\n").filter((line) => / > [\w:.]+\.53: /.test(line))) {
		const hostname = query.match(/\b[\w-]+\? ([\w.-]+)\.(?:\s|$)/)?.[1]?.toLowerCase()
		if (hostname && connections.destinations && !connections.destinations.includes(hostname)) {
			connections.destinations.push(hostname)
		}
		// flag queries with missing destination names
		if (!hostname) {
			markIncomplete(connections, "DNS query name unavailable")
		}
		// record off-list dns attempts once per destination
		if (
			hostname &&
			!allowed.includes(hostname) &&
			!connections.findings.some((f) => f.kind === "connection" && f.destination === hostname)
		) {
			// retain the attempted hostname as dns evidence
			addFinding(connections, { kind: "connection", destination: hostname, source: "dns", outcome: "unknown" })
		}
	}
}
export function inspectTrace(
	syscalls: string,
	dns: string,
	status: string,
	allowed: string[],
	initialLinks: string[] = [],
): InstallationObservations {
	const connections: Observation = { complete: true, findings: [], destinations: [] }
	const files: Observation = { complete: true, findings: [] }
	const hosts = dnsAnswers(dns)
	// Every descendant starts in the project mount. Use that invariant only if the entire trace preserves it.
	const fixedDirectory = stableProjectDirectory(syscalls) ? "/project" : undefined
	const pending = new Map<string, TraceCall>()
	const state = { links: new Map(initialLinks.map((path) => [path, undefined])), sharedOutsideMapping: false }
	let started = false
	// reconstruct each syscall before assigning it to the installer
	for (const row of syscalls.split("\n")) {
		const entry = assembled(row, pending)
		if (!entry) {
			continue
		}
		const { line, timestamp } = entry
		// identify the command boundary in the traced process
		if (line.startsWith("execve(") && line.includes('/env"') && line.endsWith("= 0")) {
			started = true
		}
		if (started) {
			network(line, hosts, timestamp, allowed, connections)
			filesystem(line, files, state, fixedDirectory)
		}
	}
	// check network capture and syscall coverage before returning findings
	recordDnsQueries(dns, allowed, connections)
	verifyTraceEnd({ started, pending, connections, files })
	if (!/\b0 packets dropped by kernel/.test(status)) {
		markIncomplete(connections, "DNS capture dropped packets")
	}
	return { connections, files }
}
// summarize names of unfinished system calls
function pendingSyscalls(pending: Map<string, TraceCall>): string[] {
	return [...new Set([...pending.values()].map((entry) => /^(\w+)\(/.exec(entry.line)?.[1] ?? "unknown"))]
}
function onlySocketReads(calls: string[]): boolean {
	return calls.every((call) => ["recvfrom", "recvmsg", "recvmmsg"].includes(call))
}
// assess whether missing trace records affect coverage
function verifyTraceEnd({
	started,
	pending,
	connections,
	files,
}: {
	started: boolean
	pending: Map<string, TraceCall>
	connections: Observation
	files: Observation
}): void {
	// report trace gaps that can hide writes or connections
	if (!started || pending.size) {
		const calls = pendingSyscalls(pending)
		const reason = started ? `unfinished ${calls.slice(0, 6).join(", ")}` : "missing execution marker"
		// allow unfinished socket reads that cannot modify files or destinations
		if (!started || !onlySocketReads(calls)) {
			markIncomplete(files, `Filesystem trace did not finish (${reason})`)
			markIncomplete(connections, `Network trace did not finish (${reason})`)
		}
	}
}
// verify the shared working directory across all traced descendants
function stableProjectDirectory(trace: string): boolean {
	const pending = new Map<string, TraceCall>()
	for (const row of trace.split("\n")) {
		const entry = assembled(row, pending)
		if (!entry || !/^(?:f?chdir|chroot|pivot_root)\(/.test(entry.line) || / = -1 /.test(entry.line)) {
			continue
		}
		// disallow directory changes away from the project
		if (!/^chdir\("\/project"\) = 0$/.test(entry.line) && !/^fchdir\(\d+<\/project>\) = 0$/.test(entry.line)) {
			return false
		}
	}
	return onlySocketReads(pendingSyscalls(pending))
}
// accept only the supervisor's per-inspection evidence directory
const directory = process.argv[2]
if (directory && /^\/var\/lib\/health-code\/evidence-[a-f0-9-]{36}$/.test(directory)) {
	const read = (name: string): string => {
		const path = `${directory}/${name}`
		// bound each capture before loading it into memory
		if (statSync(path).size >= 32 * 1024 * 1024) {
			throw new Error("Trace limit reached")
		}
		return readFileSync(path, "utf8")
	}
	try {
		// seed link tracking with the pinned project entries
		const links = read("links")
			.split("\0")
			.filter(Boolean)
			.map((path) => posix.resolve("/project", path))
		console.log(
			JSON.stringify(inspectTrace(read("syscalls"), read("dns"), read("status"), process.argv.slice(3), links)),
		)
	} finally {
		rmSync(directory, { recursive: true, force: true })
	}
}
