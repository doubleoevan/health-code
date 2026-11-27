import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { readPackageFileDigests } from "health-code"
import {
	describeOversizedExecutable,
	findEmbeddedFileDifferences,
	toExecutablePath,
	toPlatformName,
} from "./checkExecutable.ts"

const packageRoot = new URL("../../../packages/health-code/", import.meta.url)
const buildFolder = new URL("../build/", import.meta.url)
const stagedFolder = new URL("executable-files/", buildFolder)
const cliEntry = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

// keep the checkout's runtime configuration out of the executable
const autoloadFlags = [
	"--no-compile-autoload-dotenv",
	"--no-compile-autoload-bunfig",
	"--no-compile-autoload-tsconfig",
	"--no-compile-autoload-package-json",
]

buildExecutable()

// compile the CLI for this machine with exactly the package files the library reads
function buildExecutable(): void {
	const platformName = toPlatformName(process.platform, process.arch)
	if (!platformName) {
		throw new Error(`No executable ships for ${process.platform}-${process.arch}.`)
	}

	// copy the package files to the folder layout the executable embeds
	const digests = readPackageFileDigests()
	rmSync(stagedFolder, { recursive: true, force: true })
	for (const { path } of digests) {
		const stagedPath = new URL(path, stagedFolder)
		mkdirSync(new URL("./", stagedPath), { recursive: true })
		cpSync(new URL(path, packageRoot), stagedPath)
	}

	// compile with each top-level file and folder as an asset at its package path
	const executablePath = toExecutablePath(platformName)
	const assetFlags = ["package.json", "prompts", "dist"].map(
		(name) => `--asset=${fileURLToPath(new URL(name, stagedFolder))}`,
	)
	run("bun", ["build", "--compile", cliEntry, `--outfile=${executablePath}`, ...assetFlags, ...autoloadFlags])

	// confirm the executable reads every package file with the same bytes
	const description = run(executablePath, ["--version", "--json"])
	const differences = findEmbeddedFileDifferences(digests, JSON.parse(description).files)
	if (differences.length) {
		throw new Error(`The executable's package files differ: ${differences.join(", ")}.`)
	}

	// stop an accidental embed from shipping
	const executableBytes = statSync(executablePath).size
	const oversizedDescription = describeOversizedExecutable(executableBytes, statSync(process.execPath).size)
	if (oversizedDescription) {
		throw new Error(oversizedDescription)
	}

	// save the digests for the release comparison
	writeFileSync(`${executablePath}.files.json`, `${description}\n`)
	console.log(`${executablePath} (${(executableBytes / 1024 / 1024).toFixed(1)} MB)`)
}

// run a command, stop on failure and return its output
function run(command: string, args: string[]): string {
	const commandRun = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] })
	if (commandRun.status !== 0) {
		throw new Error(`${command} ${args[0]} exited with ${commandRun.status ?? commandRun.signal}.`)
	}
	return commandRun.stdout
}
