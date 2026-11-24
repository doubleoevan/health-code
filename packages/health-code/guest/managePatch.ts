import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { PatchOperation } from "../src/agentContracts.ts"
import { protectedTestFiles } from "./protectTestSupport.ts"

/**
 * Executes a protected Git operation outside the repository process.
 */
export function managePatch(root: string, request: PatchOperation): string | null {
	const source = join(root, "source")
	const work = join(root, "work")
	const env = {
		PATH: "/usr/bin:/bin",
		LANG: "C",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_INDEX_FILE: join(root, "patch-index"),
		GIT_AUTHOR_NAME: "Health Code",
		GIT_AUTHOR_EMAIL: "inspection@localhost",
		GIT_COMMITTER_NAME: "Health Code",
		GIT_COMMITTER_EMAIL: "inspection@localhost",
		GIT_TERMINAL_PROMPT: "0",
	}
	function git(args: string[], input?: string | Buffer): Buffer {
		return execFileSync(
			"/usr/bin/git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"commit.gpgSign=false",
				"-c",
				"core.attributesFile=/dev/null",
				"--literal-pathspecs",
				`--git-dir=${source}/.git`,
				...args,
			],
			{ cwd: root, env, input, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] },
		)
	}

	// validate object ids before passing them to git
	function sha(value: string): string {
		if (!/^[a-f0-9]{40}$/.test(value)) {
			throw new Error("Invalid commit")
		}
		return value
	}
	function validateFile(file: string): void {
		// require a nonempty repository-relative path
		if (
			!file ||
			file.startsWith("/") ||
			file
				.split("/")

				// reject paths traversing private or reserved directories
				.some(
					(p) =>
						!p ||
						p === "." ||
						p === ".." ||
						p.startsWith(".git") ||
						p.startsWith(".env") ||
						p === ".health-code" ||
						p === "node_modules",
				) ||
			// reject control characters that would obscure file identities
			[...file].some((char) => char.charCodeAt(0) < 32)
		) {
			throw new Error("Unsafe patch path")
		}
	}

	// resolve edits only to bounded regular working files
	function pathFor(file: string): string {
		validateFile(file)
		const path = resolve(work, file)
		if (realpathSync(path) !== path || !lstatSync(path).isFile() || lstatSync(path).size > 4 * 1024 * 1024) {
			throw new Error("Unsupported patch file")
		}
		return path
	}

	// key the protected test inventory by its inspected test paths
	function protectSource(file: string, tests: string[]): void {
		const cache = join(root, "test-support-" + createHash("sha256").update(JSON.stringify(tests)).digest("hex"))
		if (!existsSync(cache)) {
			// enumerate regular files from the inspected tree
			const files = git(["ls-tree", "-r", "-z", "HEAD"])
				.toString()
				.split("\0")
				.filter((entry) => /^100(?:644|755) blob /.test(entry))
				.map((entry) => entry.slice(entry.indexOf("\t") + 1))
			let bytes = 0

			// trace test dependencies within a bounded source budget
			const blocked = protectedTestFiles(files, tests, (path) => {
				const local = join(source, path)
				bytes += lstatSync(local).size
				if (bytes > 16 * 1024 * 1024 || realpathSync(local) !== local || !lstatSync(local).isFile()) {
					throw new Error("Inspected test support cannot be verified")
				}
				return readFileSync(local, "utf8")
			})

			// persist the computed protection set for repeated edits
			writeFileSync(cache, JSON.stringify([...blocked]), { mode: 0o400 })
		}
		if (JSON.parse(readFileSync(cache, "utf8")).includes(file)) {
			throw new Error("Source is part of the protected test harness")
		}
	}
	function commit(request: Extract<PatchOperation, { kind: "commit" }>): string {
		// seed the private index from the requested parent
		git(["read-tree", sha(request.parent)])
		for (const file of request.files) {
			const contents = readFileSync(pathFor(file))
			const previous = git(["ls-tree", "-z", request.parent, "--", file]).toString()
			const mode = previous.split(" ")[0] || "100644"

			// preserve supported git modes when recording changed blobs
			if (!["100644", "100755"].includes(mode)) {
				throw new Error("Unsupported file type")
			}
			const blob = git(["hash-object", "-w", "--stdin"], contents).toString().trim()
			git(["update-index", "--add", "--cacheinfo", `${mode},${sha(blob)},${file}`])
		}

		// validate the subject before creating the commit
		const tree = git(["write-tree"]).toString().trim()
		if (!request.subject.trim() || request.subject.length > 240 || /[\r\n]/.test(request.subject)) {
			throw new Error("Invalid commit subject")
		}

		// reject a tree identical to its parent
		if (
			tree ===
			git(["rev-parse", `${request.parent}^{tree}`])
				.toString()
				.trim()
		) {
			throw new Error("Empty patch commit")
		}

		// create the commit from the checked index tree
		return git(["commit-tree", sha(tree), "-p", request.parent, "-m", request.subject])
			.toString()
			.trim()
	}
	function replay(base: string, tip: string): string {
		// generate the binary mailbox from the verified commit range
		const mailbox = git(["format-patch", "--no-signature", "--binary", "--stdout", `${sha(base)}..${sha(tip)}`])
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(mailbox)
		const temp = mkdtempSync(join(root, "replay-"))
		const cleanEnv = { ...env, GIT_INDEX_FILE: join(temp, ".git/index") }

		// isolate replay in a temporary checkout and private index
		const local = (args: string[], input?: Buffer): Buffer =>
			execFileSync(
				"/usr/bin/git",
				["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-C", temp, ...args],
				{ env: cleanEnv, input, stdio: ["pipe", "pipe", "pipe"] },
			)
		try {
			// apply the mailbox on a fresh copy of its base
			local(["clone", "--no-checkout", "--local", "--", source, "."])
			local(["checkout", "--detach", base])
			local(["am", "--"], mailbox)
			if (local(["rev-parse", "HEAD^{tree}"]).toString() !== git(["rev-parse", `${tip}^{tree}`]).toString()) {
				throw new Error("Patch replay differs")
			}

			// return the replayed mailbox and remove the temporary clone
			return text
		} finally {
			rmSync(temp, { recursive: true, force: true })
		}
	}
	function readSource(request: Extract<PatchOperation, { kind: "read" }>): string {
		// read inspected source only from a tracked regular blob
		if (request.revision) {
			validateFile(request.file)
			const entry = git(["ls-tree", "-z", sha(request.revision), "--", request.file]).toString()
			if (!/^100(?:644|755) blob /.test(entry)) {
				throw new Error("Untracked patch source")
			}
			const blob = git(["show", `${request.revision}:${request.file}`])

			// bound the blob before returning it to the model
			if (blob.length > 65536) {
				throw new Error("File too large")
			}
			return blob.toString("utf8")
		}

		// apply the same read limit to working files
		const file = pathFor(request.file)
		if (lstatSync(file).size > 65536) {
			throw new Error("File too large")
		}
		return readFileSync(file, "utf8")
	}
	function order(commits: string[], base: string, tip: string): string {
		// recover the original series for membership checks
		const chain = git(["rev-list", "--reverse", `${sha(base)}..${sha(tip)}`])
			.toString()
			.trim()
			.split("\n")

		// require a permutation of the entire commit series
		if (
			chain.length !== commits.length ||
			new Set(commits).size !== commits.length ||
			commits.some((revision) => !chain.includes(sha(revision)))
		) {
			throw new Error("Invalid commit sequence")
		}

		// rebuild the requested series on its base
		let parent = base
		const revisions: string[] = []
		git(["read-tree", sha(base)])
		for (const revision of commits) {
			// reapply each commit's changes to the private index
			const diff = git(["diff", "--no-ext-diff", "--no-textconv", "--binary", `${revision}^`, revision, "--"])
			git(["apply", "--cached", "--whitespace=nowarn", "--binary", "-"], diff)
			const tree = sha(git(["write-tree"]).toString().trim())
			const subject = git(["show", "-s", "--format=%s", revision]).toString().trim()

			// link the recreated commit to its new parent
			parent = sha(git(["commit-tree", tree, "-p", parent, "-m", subject]).toString().trim())
			revisions.push(parent)
		}

		// verify that reordering preserves the final tree
		if (!git(["rev-parse", `${tip}^{tree}`]).equals(git(["rev-parse", `${parent}^{tree}`]))) {
			throw new Error("Reordered tree differs")
		}
		return JSON.stringify(revisions)
	}
	function loadProjectIndex(tip: string): string[] {
		// seed the index with the requested revision
		git(["read-tree", sha(tip)])
		const excluded = git(["ls-files", "-z"])
			.toString()
			.split("\0")
			.filter((path) => {
				// identify private environment files in the inspected index
				const name = path.split("/").at(-1) ?? ""
				return (name === ".env" || name.startsWith(".env.")) && name !== ".env.example"
			})

		// remove private paths before materializing the tree
		if (excluded.length) {
			git(["update-index", "--force-remove", "-z", "--stdin"], excluded.join("\0") + "\0")
		}
		return excluded
	}
	function editFile(request: Extract<PatchOperation, { kind: "edit" }>): void {
		// protect test dependencies before writing source edits
		if (request.protectTests) {
			protectSource(request.file, request.protectTests)
		}
		if (Buffer.byteLength(request.contents) > 65536) {
			throw new Error("File too large")
		}

		// validate the location and novelty of a proposed test
		if (request.createTest) {
			validateFile(request.file)
			const path = resolve(work, request.file)
			if (
				!/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path) ||
				realpathSync(dirname(path)) !== dirname(path) ||
				// reject test additions already present in the inspected tree
				git(["ls-tree", "-z", "HEAD", "--", request.file]).length
			) {
				throw new Error("Unsupported new test path")
			}

			// create new tests exclusively to preserve existing files
			writeFileSync(path, request.contents, { flag: "wx", mode: 0o644 })
		} else {
			writeFileSync(pathFor(request.file), request.contents)
		}
	}

	// dispatch the requested protected patch operation
	switch (request.kind) {
		case "order":
			return order(request.commits, request.base, request.tip)
		case "commit":
			return commit(request)
		case "export":
			return replay(request.base, request.tip)

		// verify tracked contents against the sanitized index
		case "verify": {
			const excluded = loadProjectIndex(request.tip)
			if (excluded.some((file) => lstatSync(join(work, file), { throwIfNoEntry: false }))) {
				throw new Error("Excluded environment file reappeared")
			}

			// compare the working tree with the expected tree object
			const tree = sha(git(["write-tree"]).toString().trim())
			git([`--work-tree=${work}`, "diff", "--quiet", "--no-ext-diff", "--no-textconv", tree, "--"])
			return request.tip
		}
		case "restore": {
			// rebuild the working directory from the inspected revision
			loadProjectIndex(request.tip)
			rmSync(work, { recursive: true, force: true })
			execFileSync("mkdir", ["-p", work])
			git([`--work-tree=${work}`, "checkout-index", "--all", "--force", `--prefix=${work}/`])

			// reject reserved directories supplied by the repository
			for (const name of [".health-code", ".git"]) {
				if (existsSync(join(work, name))) {
					throw new Error("Reserved project path")
				}
			}

			// prepare writable guest state for the unprivileged runner
			execFileSync("mkdir", ["-p", join(work, ".health-code/home"), join(work, ".health-code/tmp")])
			execFileSync("chown", ["-R", "--no-dereference", "65534:65534", work])
			return null
		}
		case "read": {
			return readSource(request)
		}

		// apply a bounded edit to the working copy
		case "edit":
			editFile(request)
			return null
	}
	throw new Error("Unknown patch operation")
}

// process one protected patch request from standard input
if (process.argv[1] === "/opt/health-code/patch.mjs") {
	try {
		const request = JSON.parse(readFileSync(0, "utf8")) as PatchOperation
		console.log(JSON.stringify(managePatch("/var/lib/health-code", request)))
	} catch {
		// report failure without returning raw git diagnostics
		console.error("Protected patch operation failed")
		process.exitCode = 1
	}
}
