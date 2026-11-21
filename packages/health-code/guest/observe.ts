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
function addFinding(result: Observation, finding: InstallationFinding): void {
	if (result.findings.length >= 256) {
		markIncomplete(result, "Finding limit reached")
		return
	}
	if (!result.findings.some((existing) => JSON.stringify(existing) === JSON.stringify(finding))) {
		result.findings.push(finding)
	}
}
type DnsHistory = Map<string, Map<string, number>>
function dnsAnswers(text: string): DnsHistory {
	const questions = new Map<string, string>()
	const answers: DnsHistory = new Map()
	for (const line of text.split("\n")) {
		const query = line.match(/ IP6? ([\w:.]+) > ([\w:.]+): (\d+)\+?[^?]*? (?:A|AAAA)\? ([\w.-]+)\./)
		if (query) {
			questions.set([query[1], query[2], query[3]].join("/"), (query[4] ?? "").toLowerCase())
			continue
		}
		const response = line.match(/ IP6? ([\w:.]+) > ([\w:.]+): (\d+)[*+ -]/)
		if (!response) {
			continue
		}
		const host = questions.get([response[2], response[1], response[3]].join("/"))
		if (!host) {
			continue
		}
		recordAnswer(answers, host, line)
	}
	return answers
}
function recordAnswer(answers: DnsHistory, host: string, line: string): void {
	for (const match of line.matchAll(/\b(?:A|AAAA) ([\da-f:.]+)/gi)) {
		const address = match[1] ?? ""
		if (!isIP(address)) {
			continue
		}
		const names = answers.get(address) ?? new Map<string, number>()
		const timestamp = Number.parseFloat(line)
		if (!names.has(host) && Number.isFinite(timestamp)) {
			names.set(host, timestamp)
		}
		answers.set(address, names)
	}
}
function network(line: string, hosts: DnsHistory, timestamp: number, allowed: string[], result: Observation): void {
	if (!/^(?:connect|sendto|sendmsg|sendmmsg)\(/.test(line) || !line.includes("AF_INET")) {
		return
	}
	const address = line.match(/(?:inet_addr\(|inet_pton\(AF_INET6, )"([^"]+)"/)?.[1]
	if (!address) {
		markIncomplete(result, "Socket address unavailable")
		return
	}
	if (address === "10.0.2.3" && /sin_port=htons\(53\)/.test(line)) {
		return
	}
	if (address === "::1" || address.startsWith("127.")) {
		return
	}
	const candidates = [...(hosts.get(address) ?? [])].filter(([, seen]) => seen <= timestamp).map(([host]) => host)
	if (candidates.length === 1 && candidates[0]) {
		if (!allowed.includes(candidates[0])) {
			addFinding(result, { kind: "connection", destination: candidates[0], outcome: "attempted" })
		}
		return
	}
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
	call: string
	line: string
	result: Observation
	links: FileLinks
	fixedDirectory?: string
}): string[] {
	const paths: string[] = []
	const quoted = [...line.matchAll(/(?:([\w-]+)<([^>]+)>(?:\(deleted\))?, )?"((?:[^"\\]|\\.)*)"/g)]
	const relevant = call.startsWith("symlink")
		? quoted.slice(-1)
		: /^(?:link|rename)/.test(call)
			? quoted.slice(0, 2)
			: quoted.slice(0, 1)
	for (const item of relevant) {
		const path = item[3] ?? ""
		if (path.includes("\\") || path.split("/").includes("..")) {
			markIncomplete(result, "Filesystem path escaped or contained parent components")
		}
		const resolved = mutationTarget({ item, path, fixedDirectory, line, call })
		if (resolved) {
			paths.push(resolved)
		} else {
			markIncomplete(result, `Relative filesystem change lacks a directory descriptor (${call})`)
		}
	}
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
	path: string
	item: RegExpMatchArray
	fixedDirectory?: string
	line: string
	call: string
}): string | undefined {
	if (path.startsWith("/")) {
		return path
	} else if (item[2]?.startsWith("/")) {
		return posix.resolve(item[2], path)
	} else if (fixedDirectory && (!/(?:at|at2)$/.test(call) || /AT_FDCWD, $/.test(line.slice(0, item.index)))) {
		return posix.resolve(fixedDirectory, path)
	}
}
function transferTargets(line: string, call: string): string[] {
	const descriptors = [...line.matchAll(/\d+<([^>]+)>/g)]
	const target = call === "mmap" ? descriptors[0]?.[1] : descriptors[1]?.[1]
	if (target?.startsWith("/") && (call !== "mmap" || /PROT_WRITE.*MAP_SHARED/.test(line))) {
		return [target]
	}
	return []
}
type FileState = { links: FileLinks; sharedOutsideMapping: boolean }
function observeMappings(call: string, line: string, state: FileState, result: Observation): void {
	if (call === "mmap" && line.includes("MAP_SHARED") && !line.includes("PROT_WRITE")) {
		const descriptor = line.match(/\d+<([^>]+)>/)?.[1]
		// The guest mounts /usr read-only, so these mappings cannot write back to a system file.
		if (descriptor?.startsWith("/") && !descriptor.startsWith("/usr/") && !isProjectPath(descriptor)) {
			state.sharedOutsideMapping = true
		}
	}
	if (state.sharedOutsideMapping && /^(?:pkey_)?mprotect$/.test(call) && line.includes("PROT_WRITE")) {
		markIncomplete(result, "Could not attribute a writable memory protection change to a file")
	}
}
function descriptorTargets(line: string, result: Observation): string[] {
	const target = line.match(/^\w+\(\d+<([^>]+)>/)?.[1]
	if (!target) {
		markIncomplete(result, "Writable file descriptor unavailable")
	}
	return target?.startsWith("/") ? [target] : []
}
function filesystem(line: string, result: Observation, state: FileState, fixedDirectory?: string): void {
	if (!/\)\s+= (?:0x[\da-f]+|0|[1-9]\d*)(?:<[^>]*>)?$/.test(line)) {
		return
	}
	const call = line.slice(0, line.indexOf("("))
	let paths: string[] = []
	observeMappings(call, line, state, result)
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
		paths = descriptorTargets(line, result)
	} else if (["copy_file_range", "splice", "mmap"].includes(call)) {
		paths = transferTargets(line, call)
	} else if (/^(?:open|openat|openat2|creat)$/.test(call) && /O_CREAT|O_TRUNC|^creat\(/.test(line)) {
		const target = line.match(/ = \d+<([^>]+)>$/)?.[1]
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
		paths = mutationPaths({ call, line, result, links: state.links, fixedDirectory })
	}
	for (const path of paths) {
		const normalized = posix.normalize(path)
		if (!isProjectPath(normalized) && !["/dev/null", "/dev/tty", "/dev/zero"].includes(normalized)) {
			addFinding(result, { kind: "write", path: normalized })
		}
	}
}
type TraceCall = { line: string; timestamp: number }
function assembled(row: string, pending: Map<string, TraceCall>): TraceCall | undefined {
	const match = row.match(/^(\d+)\s+(?:(\d+\.\d+)\s+)?(.*)$/)
	if (!match) {
		return
	}
	const pid = match[1] ?? ""
	let line = match[3] ?? ""
	let timestamp = Number(match[2])
	if (line.endsWith("<unfinished ...>")) {
		pending.set(pid, { line: line.replace(/\s*<unfinished \.\.\.>$/, ""), timestamp })
		return
	}
	if (line.startsWith("<... ")) {
		const previous = pending.get(pid)
		timestamp = previous?.timestamp ?? Number.NaN
		line = (previous?.line ?? "") + line.replace(/^<\.\.\. \w+ resumed>/, "")
		pending.delete(pid)
	}
	return { line, timestamp }
}
function recordDnsQueries(dns: string, allowed: string[], connections: Observation): void {
	// Preserve off-list DNS attempts even when the gateway supplies no address.
	for (const query of dns.split("\n").filter((line) => / > [\w:.]+\.53: /.test(line))) {
		const hostname = query.match(/\b[\w-]+\? ([\w.-]+)\.(?:\s|$)/)?.[1]?.toLowerCase()
		if (hostname && connections.destinations && !connections.destinations.includes(hostname)) {
			connections.destinations.push(hostname)
		}
		if (!hostname) {
			markIncomplete(connections, "DNS query name unavailable")
		}
		if (
			hostname &&
			!allowed.includes(hostname) &&
			!connections.findings.some((f) => f.kind === "connection" && f.destination === hostname)
		) {
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
	for (const row of syscalls.split("\n")) {
		const entry = assembled(row, pending)
		if (!entry) {
			continue
		}
		const { line, timestamp } = entry
		if (line.startsWith("execve(") && line.includes('/env"') && line.endsWith("= 0")) {
			started = true
		}
		if (started) {
			network(line, hosts, timestamp, allowed, connections)
			filesystem(line, files, state, fixedDirectory)
		}
	}
	recordDnsQueries(dns, allowed, connections)
	verifyTraceEnd({ started, pending, connections, files })
	if (!/\b0 packets dropped by kernel/.test(status)) {
		markIncomplete(connections, "DNS capture dropped packets")
	}
	return { connections, files }
}
function pendingSyscalls(pending: Map<string, TraceCall>): string[] {
	return [...new Set([...pending.values()].map((entry) => /^(\w+)\(/.exec(entry.line)?.[1] ?? "unknown"))]
}
function onlySocketReads(calls: string[]): boolean {
	return calls.every((call) => ["recvfrom", "recvmsg", "recvmmsg"].includes(call))
}
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
	if (!started || pending.size) {
		const calls = pendingSyscalls(pending)
		const reason = started ? `unfinished ${calls.slice(0, 6).join(", ")}` : "missing execution marker"
		if (!started || !onlySocketReads(calls)) {
			markIncomplete(files, `Filesystem trace did not finish (${reason})`)
			markIncomplete(connections, `Network trace did not finish (${reason})`)
		}
	}
}
function stableProjectDirectory(trace: string): boolean {
	const pending = new Map<string, TraceCall>()
	for (const row of trace.split("\n")) {
		const entry = assembled(row, pending)
		if (!entry || !/^(?:f?chdir|chroot|pivot_root)\(/.test(entry.line) || / = -1 /.test(entry.line)) {
			continue
		}
		if (!/^chdir\("\/project"\) = 0$/.test(entry.line) && !/^fchdir\(\d+<\/project>\) = 0$/.test(entry.line)) {
			return false
		}
	}
	return onlySocketReads(pendingSyscalls(pending))
}
const directory = process.argv[2]
if (directory && /^\/var\/lib\/health-code\/evidence-[a-f0-9-]{36}$/.test(directory)) {
	const read = (name: string): string => {
		const path = `${directory}/${name}`
		if (statSync(path).size >= 32 * 1024 * 1024) {
			throw new Error("Trace limit reached")
		}
		return readFileSync(path, "utf8")
	}
	try {
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
