type RequestConfig = (...args: Parameters<typeof fetch>) => Promise<Response>

/**
 * Reads one Doppler configuration using a token scoped to that configuration.
 */
export async function readConfiguration(
	token: string,
	request: RequestConfig = fetch,
): Promise<Record<string, string>> {
	const response = await request("https://api.doppler.com/v3/configs/config/secrets/download?format=json", {
		headers: { Authorization: `Bearer ${token}` },
		redirect: "error",
		signal: AbortSignal.timeout(8000),
	})
	if (!response.ok) {
		await response.body?.cancel()
		throw new Error("Doppler configuration unavailable")
	}

	// Discard malformed responses without writing any returned values to logs.
	const values: unknown = await response.json().catch(() => null)

	// Accept only the flat string dictionary returned by the config download endpoint.
	if (
		!values ||
		typeof values !== "object" ||
		Array.isArray(values) ||
		Object.values(values).some((value) => typeof value !== "string")
	) {
		throw new Error("Invalid Doppler configuration")
	}

	// Return validated configuration to the runtime caller.
	return values as Record<string, string>
}

export async function readSiteEnvironment(
	environment: NodeJS.ProcessEnv,
	request: RequestConfig = fetch,
): Promise<NodeJS.ProcessEnv> {
	const token = environment.HEALTH_CODE_RUNTIME_CONFIG_TOKEN
	if (!token) {
		return environment
	}
	const values = await readConfiguration(token, request)

	// Preserve platform-owned networking, production mode and replay restrictions.
	const runtime = { ...environment }
	for (const name of Object.keys(values)) {
		if (name === "HEALTH_CODE_REPLAY" || name === "HEALTH_CODE_RUNTIME_CONFIG_TOKEN") {
			continue
		}

		// Copy only app settings and the provider credentials the worker consumes.
		if (
			name.startsWith("HEALTH_CODE_") ||
			["RUNTA_TOKEN", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"].includes(name)
		) {
			runtime[name] = values[name]
		}
	}

	return runtime
}
