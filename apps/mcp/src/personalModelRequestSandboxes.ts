import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir, hostname } from "node:os"
import { join } from "node:path"
import {
	createSandboxProvider,
	isModelRequestSandboxName,
	type ModelRequestSandbox,
	type SandboxProvider,
	SandboxUnavailableError,
} from "health-code"

import { z } from "zod"
import { UserError } from "./modelSettings.ts"
import { modelRequestSandboxCleanupError, sandboxOperation } from "./probeModelRequestSandbox.ts"

export type PersonalProvider = SandboxProvider & { modelRequestSandbox: ModelRequestSandbox }

function isDead(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return false
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ESRCH"
	}
}

const ownerRoot = (): string => join(homedir(), ".health-code", "relay-owners")

function ownerFolder(identity: string): string {
	const owner = createHash("sha256").update(hostname()).update("\0").update(identity).digest("hex")
	return join(ownerRoot(), owner)
}

/**
 * Resolves the authenticated organization's recovery directory across token rotations.
 */
export async function organizationFolder({
	token,
	end,
	request = fetch,
}: {
	token: string
	end: number
	request?: typeof fetch
}): Promise<string> {
	try {
		const response = await request("https://api.runta.com/v2/model-providers", {
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			signal: sandboxOperation({ end, cap: 10000 }).signal,
		})
		if (!response.ok) {
			await response.body?.cancel()
			throw new SandboxUnavailableError(toUnavailableReason(response.status))
		}

		// Only the authenticated organization identifier belongs in the ownership scope.
		const { organization_id: id } = z
			.object({ organization_id: z.string().min(1).max(128) })
			.parse(await response.json())
		return ownerFolder(id)
	} catch (error) {
		// a failed connection or timeout is temporary
		if (error instanceof SandboxUnavailableError) {
			throw error
		}
		if (error instanceof TypeError || error instanceof DOMException) {
			throw new SandboxUnavailableError("unavailable")
		}
		throw new UserError(
			"Could not verify the Runta organization. Check account access to list model providers and retry.",
		)
	}
}

// name why Runta refused the request
function toUnavailableReason(status: number): SandboxUnavailableError["reason"] {
	if (status === 401) {
		return "authentication"
	}
	return status === 403 ? "permission" : "unavailable"
}

/**
 * Creates a Sandbox Provider after reclaiming Model Request Sandboxs left by exited processes.
 */
export async function personalProvider(token: string, end = Date.now() + 120000): Promise<PersonalProvider> {
	const provider = createSandboxProvider({ token })
	const modelRequestSandbox = provider.modelRequestSandbox
	if (!modelRequestSandbox) {
		throw new UserError("Model request sandbox unavailable. Restart your client and try again.")
	}

	// Resolve ownership before inspecting any local record.
	const folder = await organizationFolder({ token, end })
	await recoverModelRequestSandboxes({ modelRequestSandbox, folder, end })
	return Object.assign(provider, { modelRequestSandbox: recordOwnership(modelRequestSandbox, folder) })
}

/**
 * Leaves offline MCP sessions free of network traffic when there is nothing to recover.
 */
export async function recoverAccount(token: string): Promise<PersonalProvider | undefined> {
	const folders = await readdir(ownerRoot(), { withFileTypes: true }).catch((error) => {
		if (error.code === "ENOENT") {
			return []
		}
		throw error
	})

	// An empty directory from a previous success needs no remote verification.
	for (const folder of folders) {
		if (
			folder.isDirectory() &&
			/^[a-f0-9]{64}$/.test(folder.name) &&
			(await readdir(join(ownerRoot(), folder.name))).length
		) {
			// Recovery uses the authenticated organization for these private records.
			return personalProvider(token)
		}
	}
	return undefined
}

type RecoverModelRequestSandboxesOptions = { modelRequestSandbox: ModelRequestSandbox; folder: string; end?: number }

/**
 * Reclaims recorded model request sandboxes belonging to exited processes within the recovery deadline.
 */
export async function recoverModelRequestSandboxes({
	modelRequestSandbox,
	folder,
	end = Date.now() + 120000,
}: RecoverModelRequestSandboxesOptions): Promise<void> {
	const unresolved: string[] = []
	await mkdir(folder, { recursive: true, mode: 0o700 })
	for (const entry of await readdir(folder, { withFileTypes: true })) {
		if (!entry.isFile()) {
			continue
		}

		// Interpret only regular files created by a local owner.
		const file = entry.name
		const [owner, name, ...extra] = file.split(".")
		if (
			// Require both the dead process ID and the complete reserved runtime name.
			!owner ||
			!name ||
			extra.length ||
			// Ignore malformed records before probing a local PID.
			!/^[1-9]\d{0,9}$/.test(owner) ||
			!isModelRequestSandboxName(name) ||
			!isDead(Number(owner))
		) {
			continue
		}

		// Keep uncertain records for the next startup. A reused PID protects the live owner.
		try {
			const phase = await readFile(join(folder, file), "utf8").catch((error) => {
				if (error.code === "ENOENT") {
					return undefined
				}
				throw error
			})

			// Another session may already have reclaimed this recorded allocation.
			if (phase === undefined) {
				continue
			}
			await modelRequestSandbox.close(name, {
				...sandboxOperation({ end, cap: 30000 }),
				creationPending: phase !== "ready",
			})

			// Another session may already have removed this acknowledged record.
			await rm(join(folder, file), { force: true })
		} catch {
			unresolved.push(name)
		}
	}

	// Report every outstanding cleanup after attempting the other records.
	if (unresolved.length) {
		throw modelRequestSandboxCleanupError(unresolved.join(", "))
	}
}

/**
 * Records each allocation until the provider confirms deletion.
 */
export function recordOwnership(modelRequestSandbox: ModelRequestSandbox, folder: string): ModelRequestSandbox {
	const file = (name: string): string => {
		if (!isModelRequestSandboxName(name)) {
			throw new Error("Invalid model request sandbox identity")
		}
		return join(folder, `${process.pid}.${name}`)
	}

	// Tie cleanup to the exclusive record created by this provider instance.
	const registered = new Map<string, Promise<void>>()
	return {
		...modelRequestSandbox,
		async open(name, route, operation): Promise<void> {
			const path = file(name)
			if (registered.has(name)) {
				throw new Error("Duplicate model request sandbox owner")
			}

			// Publish the durable intent before dispatching the create request.
			const record = mkdir(folder, { recursive: true, mode: 0o700 }).then(() =>
				writeFile(path, "", { mode: 0o600, flag: "wx" }),
			)
			registered.set(name, record)
			await record
			operation.signal?.throwIfAborted()
			await modelRequestSandbox.open(name, route, operation)

			// A crash before this marker leaves creation uncertain.
			await writeFile(path, "ready", { flag: "r+" })
		},
		async close(name, operation): Promise<void> {
			const owned = await registered.get(name)?.then(
				() => true,
				() => false,
			)
			if (!owned) {
				registered.delete(name)
				return
			}
			await modelRequestSandbox.close(name, operation)

			// Retire the private journal entry after remote deletion succeeds.
			await rm(file(name), { force: true })
			registered.delete(name)
		},
	}
}
