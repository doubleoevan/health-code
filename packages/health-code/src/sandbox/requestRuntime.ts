import { ApiError, type Runta } from "@runta/runta-sdk"
import { checkOperation, redact } from "../collectEvents.ts"
import { type CommandResult, InspectionError, type Operation, SandboxUnavailableError } from "../contracts.ts"
export type Runtime = Awaited<ReturnType<Runta["runtimes"]["create"]>>
export function translate(error: unknown): Error {
	if (error instanceof InspectionError) {
		return error
	}
	const failure = new SandboxUnavailableError(
		availabilityReason(error instanceof ApiError ? error.statusCode : undefined),
	)
	if (error instanceof ApiError) {
		failure.cause = {
			status: error.statusCode,
			code: /^[a-z0-9_-]{1,80}$/i.test(error.code ?? "") ? error.code : undefined,
		}
	}
	return failure
}
// translate rejected sdk requests into inspection errors
export async function providerRequest<T>(request: Promise<T>): Promise<T> {
	try {
		return await request
	} catch (error) {
		throw translate(error)
	}
}
// share one deadline across successive runtime operations
export function remainingOperation(options: Operation): () => Operation {
	const end = Date.now() + options.timeoutMs
	return () => {
		checkOperation(options.signal)
		const timeoutMs = end - Date.now()
		// reject expired operations before contacting the provider
		if (timeoutMs <= 0) {
			throw new InspectionError("deadline", "Inspection interrupted")
		}
		return { signal: options.signal, timeoutMs }
	}
}

export async function exec(
	runtime: Runtime,
	argv: string[],
	options: Operation,
	limit = 65536,
): Promise<CommandResult> {
	checkOperation(options.signal)
	let result: Awaited<ReturnType<Runtime["exec"]>>
	try {
		result = await runtime.exec(argv, {
			timeoutSecs: Math.max(1, Math.ceil(options.timeoutMs / 1000)),
			maxOutputBytes: limit,
		})
	} catch (error) {
		if (error instanceof ApiError && error.code === "deadline_exceeded") {
			return {
				exitCode: 124,
				timedOut: true,
				stdout: "",
				stderr: "Command deadline reached",
				durationMs: options.timeoutMs,
				stdoutTruncated: false,
				stderrTruncated: false,
			}
		}
		throw translate(error)
	}
	return {
		exitCode: result.exitCode,
		stdout: result.stdoutText,
		stderr: result.stderrText,
		durationMs: result.durationMs,
		stdoutTruncated: result.stdoutTruncated,
		stderrTruncated: result.stderrTruncated,
	}
}
export async function checked(
	runtime: Runtime,
	argv: string[],
	options: Operation,
	requireFullOutput = false,
): Promise<string> {
	const result = await exec(runtime, argv, options)
	if (result.stdoutTruncated && requireFullOutput) {
		throw new InspectionError("output-limit", "Project file exceeds the read limit")
	}
	// surface bounded diagnostics for unsuccessful guest commands
	if (result.exitCode !== 0) {
		throw new InspectionError("sandbox-command", `Sandbox operation failed: ${redact(result.stderr).slice(-600)}`)
	}
	return result.stdout
}

export function availabilityReason(status?: number): SandboxUnavailableError["reason"] {
	if (status === 401) {
		return "authentication"
	}
	// distinguish insufficient permission from invalid authentication
	if (status === 403) {
		return "permission"
	}
	return "unavailable"
}
