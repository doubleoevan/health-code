import { afterEach, beforeEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const project = resolve(import.meta.dir, "..")
const checker = join(project, "scripts/check-comment-groups.sh")
const eight = Array.from({ length: 8 }, (_, index) => `step${index}()`).join("\n")
let root: string

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "comment groups "))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function check(name: string, source: string): number | null {
	const path = join(root, name)
	writeFileSync(path, source)
	return spawnSync("bash", [checker, path]).status
}

test.each(["ts", "mts", "js", "mjs", "sh"])("apply the eight-line limit to .%s", (extension) => {
	const name = `with space.${extension}`
	const comment = extension === "sh" ? "#" : "//"
	expect(check(name, eight)).toBe(0)
	expect(check(name, `${eight}\nninth()`)).toBe(2)

	// recognize only the comment marker for this language
	expect(check(name, `${eight}\n  ${comment} begin the next group\n${eight}`)).toBe(0)
	expect(check(name, `${eight}\n${comment === "#" ? "//" : "#"} wrong marker\n${eight}`)).toBe(2)
})

test("skip wrapped imports, continuations and block documentation", () => {
	const block = `/**\n${eight}\nmore docs\n*/`
	const imports = `import {\n${eight}\n} from "fixture"`
	expect(check("fixture.ts", [eight, imports, eight, block, eight, "value,", eight].join("\n"))).toBe(0)
})

test("resume after imports with braces in paths or a separate from clause", () => {
	for (const statement of ['import "./path{file"', 'import {\n  value\n}\nfrom "fixture"']) {
		expect(check("fixture.ts", `${statement}\n${eight}\nninth()`)).toBe(2)
	}
})

test("skip a symlink whose target has a source extension", () => {
	const target = join(root, "target.ts")
	writeFileSync(target, eight + "\nninth()")
	const link = join(root, "linked.ts")
	symlinkSync(target, link)
	expect(spawnSync("bash", [checker, link]).status).toBe(0)
})

test("resume counting shell statements after a heredoc", () => {
	for (const opener of ["cat <<'FIXTURE'", "cat <<'FIXTURE' > fixture.txt", 'cat <<-"FIXTURE">out # save data']) {
		const data = `${opener}\n${eight}\nfixture data\nFIXTURE`
		expect(check("fixture.sh", `${data}\n${eight}`)).toBe(0)
		expect(check("fixture.sh", `${data}\n${eight}\nninth`)).toBe(2)
	}
})

test("count shell commands after literal heredoc operators", () => {
	for (const line of ["cat <<<WORD", "printf ready # <<EOF", "printf '<<EOF'", 'printf "<<EOF"', "printf \\<\\<EOF"]) {
		expect(check("fixture.sh", `${line}\n${eight}`)).toBe(2)
	}
})

test("recognize heredocs inside quoted command substitutions", () => {
	const data = `text="$(cat <<'FIXTURE'\n${eight}\npayload\nFIXTURE\n)"`
	expect(check("fixture.sh", `${data}\n# read the captured text\n${eight}`)).toBe(0)
	expect(check("fixture.sh", `${data}\n# read the captured text\n${eight}\nninth`)).toBe(2)
	expect(check("fixture.sh", `printf "$(printf ok) <<FIXTURE"\n${eight}`)).toBe(2)
})

test("report all tracked violations and preserve unusual filenames", () => {
	// construct an index with both measured and exempt files
	expect(spawnSync("git", ["init", "-q"], { cwd: root }).status).toBe(0)
	const names = ["first.ts", "second\nfile.mjs", "markup.tsx", "notes.md"]
	for (const name of [...names, "untracked.js"]) {
		writeFileSync(join(root, name), eight + "\nninth()")
	}
	expect(spawnSync("git", ["add", "--", ...names], { cwd: root }).status).toBe(0)

	// restrict diagnostics to the indexed source files
	const nested = join(root, "nested")
	mkdirSync(nested)
	const result = spawnSync("bash", [checker, "--tracked"], { cwd: nested, encoding: "utf8" })
	expect(result.status).toBe(2)
	expect(result.stderr).toContain("first.ts:1")
	expect(result.stderr).toContain(String.raw`$'second\nfile.mjs':1`)
	expect(result.stderr).not.toMatch(/markup\.tsx|notes\.md|untracked\.js/)
})

test("run the configured edit hook from a different directory", () => {
	// exercise the same command and json payload used by claude code
	const settings = JSON.parse(readFileSync(join(project, ".claude/settings.json"), "utf8"))
	const hook = settings.hooks.PostToolUse.find((entry: { matcher: string }) => entry.matcher === "Edit|Write|MultiEdit")
	const invoke = (path: string): number | null =>
		spawnSync("sh", ["-c", hook.hooks[0].command], {
			cwd: root,
			env: { ...process.env, CLAUDE_PROJECT_DIR: project },
			input: JSON.stringify({ tool_input: { file_path: path } }),
		}).status

	// check a newly written source file and leave jsx for manual review
	for (const [name, status] of [
		["edited file.ts", 2],
		["view.tsx", 0],
	] as const) {
		const path = join(root, name)
		writeFileSync(path, eight + "\nninth()")
		expect(invoke(path)).toBe(status)
	}
})
