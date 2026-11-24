import assert from "node:assert/strict"
import { test } from "node:test"
import { inspectSandboxActivity } from "../guest/inspectSandboxActivity.ts"
import type { Observation } from "../src/index.ts"
import { buildGuestArguments } from "../src/sandbox/buildGuestArguments.ts"

test("uses resolved descriptor targets for writes through symlinks", () => {
	const result = inspectSandboxActivity(
		'1 execve("/usr/bin/env", [], []) = 0\n1 openat(AT_FDCWD</project>, "link", O_WRONLY|O_TRUNC) = 3</tmp/actual>\n1 write(3</tmp/actual>, "x", 1) = 1',
		"",
		"0 packets dropped by kernel",
		[],
	)
	assert.deepEqual(result.files, { complete: true, findings: [{ kind: "write", path: "/tmp/actual" }] })
})

test("unexpected DNS questions and ambiguous metadata writes cannot produce a clean install", () => {
	const trace = ['1 execve("/usr/bin/env", [], []) = 0', '1 mkdirat(AT_FDCWD</project>, "linked/dir", 0755) = 0'].join(
		"\n",
	)
	const result = inspectSandboxActivity(
		trace,
		"1 IP 10.0.2.1.111 > 10.0.2.3.53: 11+ TXT? example.org. (30)",
		"0 packets dropped by kernel",
		[],
		["/project/linked"],
	)

	// check both uncertainty and the unexpected dns destination
	assert.equal(result.files.complete, false)
	assert.deepEqual(result.connections.findings, [
		{ kind: "connection", destination: "example.org", source: "dns", outcome: "unknown" },
	])
})

test("path metadata operations that follow the last symlink report incomplete coverage", () => {
	const trace = '1 execve("/usr/bin/env", [], []) = 0\n1 chmod("/project/linked", 0600) = 0'
	assert.equal(
		inspectSandboxActivity(trace, "", "0 packets dropped by kernel", [], ["/project/linked"]).files.complete,
		false,
	)
})

test("only DNS answers preceding a connection can establish its destination", () => {
	const trace = [
		'1 1.000000 execve("/usr/bin/env", [], []) = 0',
		'1 2.000000 connect(3, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("192.0.2.5")}, 16) = -1 EINPROGRESS',
	].join("\n")
	const dns =
		"3 IP 10.0.0.2.123 > 10.0.0.1.53: 10+ A? registry.npmjs.org. (29)\n4 IP 10.0.0.1.53 > 10.0.0.2.123: 10 1/0/0 A 192.0.2.5"

	// keep an address unresolved when its dns response follows the connection
	const result = inspectSandboxActivity(trace, dns, "0 packets dropped by kernel", ["registry.npmjs.org"])
	assert.equal(result.connections.complete, false)
	assert.deepEqual(result.connections.findings, [{ kind: "connection", destination: "192.0.2.5", outcome: "unknown" }])
})

test("records descriptor metadata and keeps ambiguous mapping changes incomplete", () => {
	const trace = [
		'1 execve("/usr/bin/env", [], []) = 0',
		"1 fchmod(3</tmp/metadata>, 0600) = 0",
		"1 mmap(NULL, 4096, PROT_READ, MAP_SHARED, 4</tmp/shared>, 0) = 0x1234",
	]
	const read = (lines: string[]): Observation =>
		inspectSandboxActivity(lines.join("\n"), "", "0 packets dropped by kernel", []).files

	// distinguish a known metadata write from an ambiguous mapped write
	assert.deepEqual(read(trace), { complete: true, findings: [{ kind: "write", path: "/tmp/metadata" }] })
	assert.equal(read([...trace, "1 mprotect(0x1234, 4096, PROT_READ|PROT_WRITE) = 0"]).complete, false)
})

test("normalizes renamed link ancestors and reads descriptor-only timestamp changes", () => {
	const trace = [
		'1 execve("/usr/bin/env", [], []) = 0',
		'1 rename("/project/./dir", "/project/moved") = 0',
		'1 utime("/project/moved/link", NULL) = 0',
		"1 utimensat(3</tmp/outside>, NULL, NULL, 0) = 0",
	].join("\n")

	// retain descriptor writes when a renamed link obscures path coverage
	const result = inspectSandboxActivity(trace, "", "0 packets dropped by kernel", [], ["/project/dir/link"])
	assert.equal(result.files.complete, false)
	assert.deepEqual(result.files.findings, [{ kind: "write", path: "/tmp/outside" }])
})

test("observes pnpm permission changes through project links alongside read-only system mappings", () => {
	const trace = [
		'1 execve("/usr/bin/env", [], []) = 0',
		"1 mmap(NULL, 4096, PROT_READ, MAP_SHARED, 3</usr/lib/gconv/gconv-modules.cache>, 0) = 0x1000",
		"2 mprotect(0x4000, 4096, PROT_READ|PROT_WRITE) = 0",
		'2 symlink("../acorn@8/node_modules/acorn", "/project/.pnpm/node_modules/acorn") = 0',
		'2 symlinkat(".pnpm/node_modules/acorn", AT_FDCWD</project>, "acorn") = 0',
		'2 chmod("/project/acorn/bin/acorn", 0755) = 0',
		'2 openat(AT_FDCWD</project>, "/tmp/log", O_CREAT|O_WRONLY, 0600) = 4</tmp/log>',
	].join("\n")

	// check the read-only mount and the write that escapes the project
	const { argv: args } = buildGuestArguments({ argv: ["true"], timeoutMs: 1000 }, undefined)
	const mount = args.indexOf("/usr")
	assert.deepEqual(args.slice(mount - 1, mount + 2), ["--ro-bind", "/usr", "/usr"])
	assert.deepEqual(inspectSandboxActivity(trace, "", "0 packets dropped by kernel", []).files, {
		complete: true,
		findings: [{ kind: "write", path: "/tmp/log" }],
	})
})

test("keeps coverage incomplete for escaping, cyclic, or replaced link targets", () => {
	const start = '1 execve("/usr/bin/env", [], []) = 0'
	for (const links of [
		['1 symlink("../outside", "/project/link") = 0'],
		['1 symlink("link", "/project/link") = 0'],
		['1 symlink("/tmp", "/project/alias") = 0', '1 symlink("alias/../project", "/project/link") = 0'],
		[
			'1 symlink("/tmp", "/project/link") = 0',
			'1 unlink("/project/link") = 0',
			'1 symlink("pkg", "/project/link") = 0',
		],
		['1 symlink("pkg", "/project/link") = 0', '1 rename("/project/replacement", "/project/link") = 0'],
	]) {
		// apply the metadata change through each ambiguous link
		const trace = [start, ...links, '1 chmod("/project/link/bin", 0755) = 0'].join("\n")
		const files = inspectSandboxActivity(trace, "", "0 packets dropped by kernel", []).files
		assert.equal(files.complete, false)
		assert.match(files.reason ?? "", /symbolic link/)
	}
})

test("attributes relative installs until a traced process can change directory", () => {
	const start = '1 execve("/usr/bin/env", [], []) = 0'
	const link = '1 symlink("target", "link") = 0'
	const change = '2 chdir("/project/pkg") = 0'
	const read = (rows: string[]): Observation =>
		inspectSandboxActivity([start, ...rows], "", "0 packets dropped by kernel", []).files

	// Follow each process once its parent is recorded.
	const spawn = "1 clone(child_stack=NULL, flags=CLONE_CHILD_SETTID|SIGCHLD) = 2"
	const thread = "1 clone3({flags=CLONE_VM|CLONE_FS|CLONE_THREAD, exit_signal=0}, 88) = 2"
	assert.equal(read([spawn, change, link]).complete, true)
	assert.deepEqual(read([spawn, '2 chdir("/tmp") = 0', link, '2 symlink("target", "link") = 0']), {
		complete: true,
		findings: [{ kind: "write", path: "/tmp/link" }],
	})

	// A child can act before its parent's process call returns.
	const started = "1 vfork( <unfinished ...>"
	assert.deepEqual(read([started, '2 chdir("/tmp") = 0', "1 <... vfork resumed>) = 2", link]), {
		complete: true,
		findings: [],
	})

	// Threads share one directory, and a failed change leaves it in place.
	assert.deepEqual(read([thread, '2 chdir("/tmp") = 0', link]).findings, [{ kind: "write", path: "/tmp/link" }])
	assert.equal(read([spawn, '2 chdir("/missing") = -1 ENOENT (No such file or directory)', link]).complete, true)

	// Leave moved, escaped and concurrently changed directories unattributed.
	const childLink = '2 symlink("target", "link") = 0'
	for (const rows of [
		[spawn, change, '1 rename("/project/pkg", "/project/moved") = 0', childLink],
		[spawn, '2 chdir("../elsewhere") = 0', childLink],

		// a rename can take effect before its call returns
		[
			spawn,
			change,
			'1 rename("/project/pkg", "/project/moved" <unfinished ...>',
			childLink,
			"1 <... rename resumed>) = 0",
		],

		// a child keeps the changed root it inherits
		['1 chroot("/project/pkg") = 0', spawn, '2 chdir("/project") = 0', childLink],
		[thread, '1 symlink("target", "link" <unfinished ...>', change, "1 <... symlink resumed>) = 0"],
		[thread, "2 unshare(CLONE_FS) = 0", '2 chdir("/project/pkg") = 0', link],
		["1 clone3(0x7ffd, 88) = 2", '2 chdir("/project/pkg") = 0', link],
		[spawn, change, "1 clone(child_stack=NULL, flags=SIGCHLD) = 2", childLink],
	]) {
		assert.equal(read(rows).complete, false, rows.join("\n"))
	}

	// Keep earlier evidence and treat even an unfinished change as ambiguous for concurrent writes.
	assert.equal(read([link, change]).complete, true)
	assert.equal(read([change, link]).complete, false)
	assert.equal(read(['2 chdir("/project/pkg" <unfinished ...>', link, "2 <... chdir resumed>) = 0"]).complete, false)
})

test("Bun hardlinks anonymous temporary inodes into the project", () => {
	const trace = [
		'2 execve("/usr/bin/env", [], []) = 0',
		'2 linkat(5</project/.cache/#123>(deleted), "", 6</project/node_modules>, "pkg", AT_EMPTY_PATH) = 0',
	].join("\n")
	assert.deepEqual(inspectSandboxActivity(trace, "", "0 packets dropped by kernel", []).files, {
		complete: true,
		findings: [],
	})
})

test("network observation traces all outbound address-bearing calls and keeps unfinished sends inconclusive", () => {
	// inspect an unfinished system call under network observation
	const { argv: args } = buildGuestArguments({ argv: ["true"], timeoutMs: 1000, observe: "network" }, "/evidence")
	assert.ok(args.includes("trace=execve,connect,sendto,sendmsg,sendmmsg"))
	const inspect = (name: string): ReturnType<typeof inspectSandboxActivity> =>
		inspectSandboxActivity(
			`1 execve("/usr/bin/env", [], []) = 0\n2 ${name}(3, <unfinished ...>`,
			"",
			"0 packets dropped by kernel",
			[],
		)

	// distinguish inbound calls from outbound sends and writes
	assert.equal(inspect("recvfrom").connections.complete, true)
	assert.equal(inspect("recvfrom").files.complete, true)
	assert.equal(inspect("write").files.complete, false)
	assert.equal(inspect("sendto").connections.complete, false)
})
