import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { toHash } from "./storeInspection.ts"

const releaseWorkspace = fileURLToPath(new URL("../../packages/health-code", import.meta.url))
function checkStderr(key: string): (chunk: Buffer | string) => void {
	let suffix = ""
	return (chunk) => {
		const output = suffix + chunk.toString()
		assert.ok(!output.includes(key), "Server stderr disclosed the model key.")
		// Carry a possible key prefix into the next stream chunk.
		suffix = output.slice(Math.max(0, output.length - key.length + 1))
	}
}

test("the stderr check detects a model key split across chunks", () => {
	const check = checkStderr("fixture-model-key")
	check(Buffer.from("output fixture-"))
	check(Buffer.from("model-"))
	assert.throws(() => check(Buffer.from("key\n")), /stderr disclosed/)
})

test("packed Node MCP tools support offline inspection and durable results", { timeout: 30000 }, async () => {
	// create a temporary home for the installed release
	const scratch = await mkdtemp(join(tmpdir(), "health-code-mcp-package-"))
	const home = join(scratch, "home")
	const installed = join(home, "node_modules", "health-code")
	const id = randomUUID()
	// bind the fixture mailbox to its expected digest
	const mailbox = "Subject: [PATCH] adopt feature\n\nverified fixture\n"
	const sha256 = toHash(mailbox)
	const repositoryUrl = "https://github.com/example/project"
	const modelKey = "fixture-model-key-never-print"
	const settings = {
		PATH: process.env.PATH ?? "",
		HOME: home,
		USERPROFILE: home,
		npm_config_offline: "true",
		npm_config_cache: join(scratch, "cache"),
		ANTHROPIC_API_KEY: modelKey,
		RUNTA_TOKEN: "fixture-token",
	}
	const fixture = fileURLToPath(new URL("../../scripts/fixtures/recorded/inspection.json", import.meta.url))

	async function connect({ command, args, cwd }: { command: string; args: string[]; cwd: string }): Promise<Client> {
		const transport = new StdioClientTransport({
			command,
			args,
			cwd,
			env: settings,
			stderr: "pipe",
		})
		// inspect server diagnostics throughout the client session
		transport.stderr?.on("data", checkStderr(modelKey))
		const client = new Client({ name: "package-test", version: "1" })
		await client.connect(transport)
		return client
	}
	try {
		// Extract the exact archive npm delivers and resolve only its declared dependencies.
		execFileSync("npm", ["pack", "--silent", "--pack-destination", scratch], {
			cwd: releaseWorkspace,
			encoding: "utf8",
			env: settings,
		})
		const archives = (await readdir(scratch)).filter((name) => name.endsWith(".tgz"))
		assert.equal(archives.length, 1)
		const [archive] = archives
		assert.ok(archive)
		// unpack the tarball under its public package name
		await mkdir(installed, { recursive: true })
		execFileSync("tar", ["-xf", join(scratch, archive), "-C", installed, "--strip-components=1"])
		const packed = JSON.parse(await readFile(join(installed, "package.json"), "utf8"))
		assert.equal(packed.name, "health-code")
		assert.equal(packed.bin["health-code"], "dist/mcp/cli.js")
		// compare the release manifest with the private app's runtime pins
		const workspace = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"))
		const { [packed.name]: selfReference, ...runtime } = workspace.dependencies
		assert.equal(selfReference, "workspace:*")
		for (const [name, version] of Object.entries(runtime)) {
			assert.equal(packed.dependencies[name], version, `Missing runtime dependency or version mismatch: ${name}`)
		}
		await writeFile(
			join(home, "package.json"),
			JSON.stringify({ private: true, dependencies: { "health-code": packed.version } }),
		)
		// link declared dependencies for an offline installation
		for (const name of Object.keys(packed.dependencies)) {
			const path = join(installed, "node_modules", name)
			await mkdir(join(path, ".."), { recursive: true })
			await symlink(await realpath(join(releaseWorkspace, "node_modules", name)), path)
		}
		execFileSync("npm", ["rebuild", "--ignore-scripts", "health-code"], { cwd: home, env: settings })
		// Exercise the pinned SDK against a local fetch double at the executable boundary.
		const intercept = join(scratch, "setup-transport.mjs")
		await writeFile(
			intercept,
			`
 import assert from "node:assert/strict"
 globalThis.fetch=async (input,options)=>{
   const url=new URL(input)
   assert.equal(url.origin,"https://api.runta.com")
   assert.equal(new Headers(options.headers).get("Authorization"),"Bearer "+process.env.RUNTA_TOKEN)
   if(url.pathname==="/v2/runtimes"){return Response.json({data:[]})}
   // verify registration against the account's named secret endpoint
   assert.match(url.pathname,/^\\/v2\\/secrets\\/health-code-model-/)
   assert.equal(options.method,"PUT")
   assert.equal(JSON.parse(options.body).value,process.env.ANTHROPIC_API_KEY)
   const failure=process.env.FIXTURE_DENIED==="yes"
   return Response.json(failure?{message:process.env.ANTHROPIC_API_KEY}:{data:{name:"registered"}},{status:failure?403:200})
 }
 `,
		)
		// exercise failed and successful setup through the installed command
		let entry: { command: string; args: string[] } | undefined
		for (const denied of ["yes", "no"]) {
			const setup = spawnSync("npx", ["health-code", "mcp", "setup"], {
				cwd: home,
				encoding: "utf8",
				env: { ...settings, NODE_OPTIONS: `--import="${intercept}"`, FIXTURE_DENIED: denied },
			})
			assert.equal(
				setup.status,
				denied === "yes" ? 1 : 0,
				setup.stderr.replaceAll(modelKey, "[redacted]").replaceAll(settings.RUNTA_TOKEN, "[redacted]"),
			)
			if (denied === "no") {
				entry = JSON.parse(`{${setup.stdout.split("\n")[2]}}`)["health-code"]
				assert.ok(entry?.args.join(" ").includes(`health-code@${packed.version} mcp`))
			}
			// inspect both output streams for either credential
			assert.ok(!(setup.stdout + setup.stderr).includes(modelKey))
			assert.ok(!(setup.stdout + setup.stderr).includes(settings.RUNTA_TOKEN))
			assert.equal(setup.stdout.includes("mcp_servers.health-code"), denied === "no")
		}
		// Launch the shipped command and read an independent session's recorded evidence.
		const mailboxDir = join(home, ".health-code", "inspections", id)
		await mkdir(join(mailboxDir, "results"), { recursive: true })
		const base = {
			role: "upgrade",
			id: "upgrade",
			filename: "upgrade.patch",
			base: "a".repeat(40),
			testedTip: "b".repeat(40),
			mailbox,
			digest: sha256,
			prompt: "Verify SHA-256, branch, apply and test.",
			commits: [],
		}
		// put the feature patch on top of the tested upgrade tip
		const featureMail = "Subject: [PATCH] use the feature\n\nfeature fixture\n"
		const featureDigest = toHash(featureMail)
		const feature = {
			...base,
			id: "feature",
			role: "feature",
			base: base.testedTip,
			testedTip: "c".repeat(40),
			prerequisite: base.id,
			mailbox: featureMail,
			digest: featureDigest,
		}
		const card = {
			version: 2,
			inspectionId: id,
			repository: { url: repositoryUrl, commit: "a".repeat(40) },
			baseline: {},
			timeline: [],
			upgrades: [{ dependency: "widget", verdict: "Fixed", patches: [base, feature] }],
		}
		await writeFile(join(mailboxDir, "card.json"), JSON.stringify(card))
		assert.ok(entry)
		// Start from a separate checkout and resolve the installed package from the temporary home.
		const checkout = join(scratch, "checkout")
		await mkdir(checkout)
		await writeFile(join(checkout, "package.json"), '{"name":"example","private":true}')
		const client = await connect({ ...entry, cwd: checkout })
		try {
			// verify discovery and read evidence written by another session
			assert.equal(client.getServerVersion()?.version, packed.version)
			assert.equal((await client.listTools()).tools.length, 4)
			const reportCard = await client.callTool({ name: "read_inspection", arguments: { inspectionId: id } })
			assert.ok(!reportCard.isError)
			const selected = await client.callTool({
				name: "get_tested_patch",
				arguments: { inspectionId: id, sha256: featureDigest, checkout: { relationship: "ahead", dirty: false } },
			})
			// verify the selected patch digest and its prerequisite
			const selectedPatch = selected.structuredContent as { prerequisiteSha256: string; text: string; sha256: string }
			assert.equal(selectedPatch.prerequisiteSha256, sha256)
			assert.equal(toHash(selectedPatch.text), selectedPatch.sha256)
			const fetch = await client.callTool({ name: "get_tested_patch", arguments: { inspectionId: id, sha256 } })
			assert.ok(!fetch.isError)
			assert.equal((fetch.structuredContent as { text: string }).text, mailbox)
			const outcome = {
				inspectionId: id,
				sha256: featureDigest,
				application: "adapted",
				adaptation: "Updated import",
				tests: "passed",
				pullRequest: `${repositoryUrl}/pull/2`,
			}
			// record an application result and reject a credential-bearing retry
			const report = await client.callTool({ name: "report_patch_result", arguments: outcome })
			assert.ok(!report.isError)
			const refused = await client.callTool({
				name: "report_patch_result",
				arguments: { ...outcome, adaptation: modelKey },
			})
			assert.equal(refused.isError, true)
			for (const result of [fetch, report, refused]) {
				assert.ok(!JSON.stringify(result).includes(modelKey))
			}
		} finally {
			await client.close()
		}

		// Run the same packed server with the public fake provider at its injection boundary.
		const replay = await connect({
			command: "node",
			args: [
				"--input-type=module",
				"-e",
				`
 import {readFileSync} from "node:fs"
 import {createFakeSandboxProvider,inspectRepository} from "health-code"
 import {StdioServerTransport} from "@modelcontextprotocol/server/stdio"
 import {createServer} from "./dist/mcp/createServer.js"
 import {InspectionStore} from "./dist/mcp/storeInspection.js"
 import {Inspections} from "./dist/mcp/trackInspections.js"
 const sandboxProvider=createFakeSandboxProvider(JSON.parse(readFileSync(process.argv[1],"utf8")))
 const inspections=new Inspections(new InspectionStore(),options=>inspectRepository({...options,sandboxProvider}))
 await createServer(inspections,"fixture").connect(new StdioServerTransport())
 `,
				fixture,
			],
			cwd: installed,
		})
		try {
			// reopen the recorded result in the new server process
			const recovered = await replay.callTool({ name: "read_inspection", arguments: { inspectionId: id } })
			assert.deepEqual((recovered.structuredContent as { results: unknown[] }).results.length, 1)
			const response = await replay.callTool({ name: "start_inspection", arguments: { repositoryUrl } })
			assert.ok(!response.isError)
			// poll the accepted id until the report is complete
			const accepted = response.structuredContent as { inspectionId: string }
			let cursor = 0
			let status = ""
			const end = Date.now() + 10000
			while (status !== "complete" && Date.now() < end) {
				const read = await replay.callTool({
					name: "read_inspection",
					arguments: { inspectionId: accepted.inspectionId, afterSequence: cursor, waitMs: 100 },
				})
				assert.ok(!read.isError)
				assert.ok(!JSON.stringify(read).includes(modelKey))
				// advance the event cursor only after checking the tool result
				const details = read.structuredContent as { status: string; nextSequence: number }
				status = details.status
				cursor = details.nextSequence
			}
			assert.equal(status, "complete")
			// inspect the persisted report for leaked credentials
			assert.ok(
				!(
					await readFile(join(home, ".health-code", "inspections", accepted.inspectionId, "card.json"), "utf8")
				).includes(modelKey),
			)
		} finally {
			await replay.close()
		}
		console.log("Packed MCP server passed Node stdio discovery, fake inspection, Patch handoff and restart checks.")
	} finally {
		// remove the installed package and all recorded evidence
		await rm(scratch, { recursive: true, force: true })
	}
})
