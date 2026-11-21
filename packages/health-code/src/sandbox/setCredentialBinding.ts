import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { ModelRoute } from "../agentContracts.ts"
import { InspectionError } from "../contracts.ts"

const secret = z.object({ id: z.string().min(1), display_name: z.string() })
const rule = z
	.object({
		secret_id: z.string(),
		environment: z.array(z.unknown()).default([]),
		files: z.array(z.unknown()).default([]),
		egress_rules: z.array(
			z
				.object({
					action: z.literal("header"),
					name: z.string(),
					host_pattern: z.string(),
					path_pattern: z.string(),
					value_template: z.string(),
				})
				.strict(),
		),
	})
	.strict()
const metadata = z.object({
	data: z.object({
		id: z.string(),
		revision: z.number().int().nonnegative(),
		secret_configuration: z.array(rule),
		tls_passthrough_hosts: z.array(z.string()).default([]),
		tcp_allowlist: z.array(z.string()).default([]),
	}),
})
type Binding = z.infer<typeof rule>
type Options = {
	request: typeof fetch
	token: string
	runtimeId: string

	// scope attachment or removal to a single model route
	route: ModelRoute
	remove?: Binding
	signal?: AbortSignal
}
const origin = "https://api.runta.com"

/**
 * Sets and verifies the runtime's single scoped egress credential.
 */
export async function setCredentialBinding(options: Options): Promise<Binding> {
	// Switch this integration to runtime.secrets.setSecretStub when the TypeScript SDK ships it.
	const target = credentialTarget(options.route)
	async function request(path: string, init?: RequestInit): Promise<unknown> {
		const response = await options.request(origin + path, {
			...init,
			signal: options.signal,
			redirect: "error",
			headers: { authorization: `Bearer ${options.token}`, "content-type": "application/json" },
		})
		if (!response.ok) {
			await response.body?.cancel()
			throw new InspectionError("credential-binding", `Runtime credential request failed (${response.status})`)
		}
		return response.json()
	}

	// read the runtime revision and verify its network configuration
	const runtimePath = `/v2/runtimes/${encodeURIComponent(options.runtimeId)}`
	const read = async (): Promise<z.infer<typeof metadata>["data"]> => {
		const { data } = metadata.parse(await request(runtimePath))
		if (data.id !== options.runtimeId || data.tls_passthrough_hosts.length || data.tcp_allowlist.length) {
			throw new InspectionError("credential-binding", "Unexpected runtime network configuration")
		}
		return data
	}

	// compare the complete existing binding set before changing it
	const before = await read()
	const expected = options.remove ? [options.remove] : []
	if (!isDeepStrictEqual(before.secret_configuration, expected)) {
		throw new InspectionError("credential-binding", "Unexpected existing credential configuration")
	}
	let binding = options.remove
	if (!binding) {
		// resolve the requested secret name to one stored secret
		const { data } = z.object({ data: z.array(secret) }).parse(await request("/v2/secrets"))
		const named = data.filter((entry) => entry.display_name === options.route.credential.name)
		if (named.length !== 1 || !named[0]) {
			throw new InspectionError("credential-binding", "Stored model credential unavailable or ambiguous")
		}
		binding = {
			secret_id: named[0].id,
			environment: [],
			files: [],
			egress_rules: [
				{
					action: "header",
					name: options.route.credential.header,
					host_pattern: target.hostname,
					path_pattern: target.pathname,
					value_template: options.route.credential.valueTemplate.replace(`\${credential}`, `\${secret}`),
				},
			],
		}
	}
	const configuration = options.remove ? [] : [binding]
	await request(`${runtimePath}?expected_revision=${before.revision}`, {
		method: "PATCH",
		body: JSON.stringify({ secret_configuration: configuration }),
	})
	const after = await read()
	if (after.revision <= before.revision || !isDeepStrictEqual(after.secret_configuration, configuration)) {
		throw new InspectionError("credential-binding", "Credential configuration readback failed")
	}
	return binding
}

/**
 * Resolves the exact authenticated inference endpoint for the caller's protocol.
 */
export function credentialTarget(route: ModelRoute): URL {
	const base = URL.parse(route.baseUrl)
	const { header, valueTemplate, name } = route.credential ?? {}

	// require an https endpoint without embedded credentials
	if (
		base?.protocol !== "https:" ||
		base.username ||
		base.password ||
		base.search ||
		base.hash ||
		base.port ||
		// constrain the hostname and path used for gateway matching
		!/^[a-z0-9.-]+$/.test(base.hostname) ||
		!base.hostname.includes(".") ||
		/[%*]/.test(base.pathname) ||
		!/^[a-z][a-z0-9-]*$/i.test(header) ||
		/^(?:host|connection|content-.*|proxy-.*|cookie|forwarded|transfer-encoding)$/i.test(header) ||
		// limit credential substitution to the configured header template
		!/^(?:Bearer )?\$\{credential\}$/.test(valueTemplate) ||
		!name ||
		!route.modelId ||
		!["anthropic", "openai-compatible"].includes(route.protocol)
	) {
		throw new InspectionError("invalid-model-route", "Invalid scoped credential route")
	}

	// append the protocol's exact inference path
	base.pathname =
		base.pathname.replace(/\/$/, "") + (route.protocol === "anthropic" ? "/messages" : "/chat/completions")
	return base
}
