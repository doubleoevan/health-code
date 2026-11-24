const requestFailed = "The request failed."

// the JSON-RPC messages exchanged with the client
type Message = {
	jsonrpc: "2.0"
	id?: number | string
	method?: string
	params?: Record<string, unknown>
	result?: Record<string, unknown>
	error?: { message?: string }
}

// the client details the page reads
type HostContext = { theme?: string }
type HostCapabilities = { message?: object; openLinks?: object }

// a tool result delivered by the client or returned from a call
export type ToolResult = {
	isError?: boolean
	structuredContent?: Record<string, unknown>
	content?: { type: string; text?: string }[]
}

// the client actions available to the page
export type Host = {
	canMessage: () => boolean
	callTool: <Output>(name: string, input: Record<string, unknown>) => Promise<Output>
	sendMessage: (text: string) => Promise<void>
	openLink: (url: string) => void
}

// the client messages the page handles
type HostEvents = {
	onToolInput: (input: Record<string, unknown>) => void
	onToolResult: (result: ToolResult) => void
	onToolCancelled: () => void
}

/**
 * Connects the page to the MCP client that shows it.
 */
export function connectHost(events: HostEvents): Host {
	let lastId = 0
	let capabilities: HostCapabilities = {}

	// a client can also report the calls that the page makes
	let hasToolResult = false
	const pending = new Map<
		number,
		{ resolve: (result: Record<string, unknown>) => void; reject: (error: Error) => void }
	>()

	// send one message to the client
	function post(message: Omit<Message, "jsonrpc">): void {
		window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*")
	}

	// resolve when the client answers the numbered request
	function request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = ++lastId
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject })
			post({ id, method, params })
		})
	}

	// accept messages from the client's window only
	window.addEventListener("message", ({ source, data }: MessageEvent<Message | undefined>) => {
		if (source !== window.parent || data?.jsonrpc !== "2.0") {
			return
		}
		if (data.method) {
			handleHostMessage(data.method, data)
			return
		}

		// settle the request that this message answers
		const call = pending.get(Number(data.id))
		pending.delete(Number(data.id))
		if (data.error) {
			call?.reject(new Error(data.error.message ?? "The client refused the request."))
		} else {
			call?.resolve(data.result ?? {})
		}
	})

	function handleHostMessage(method: string, { id, params = {} }: Message): void {
		// keep the screen of the tool call that opened the page
		if (hasToolResult && method.startsWith("ui/notifications/tool-")) {
			return
		}

		// pass the tool call to the screens
		switch (method) {
			case "ui/notifications/tool-input":
				events.onToolInput((params.arguments ?? {}) as Record<string, unknown>)
				break
			case "ui/notifications/tool-result":
				hasToolResult = true
				events.onToolResult(params as ToolResult)
				break

			// handle a cancelled call or a theme change
			case "ui/notifications/tool-cancelled":
				hasToolResult = true
				events.onToolCancelled()
				break
			case "ui/notifications/host-context-changed":
				applyTheme(params as HostContext)
				break
			default:
				// answer requests such as ping and teardown
				if (id !== undefined) {
					post({ id, result: {} })
				}
		}
	}

	// finish the handshake before reporting the page size
	void request("ui/initialize", {
		protocolVersion: "2026-01-26",
		appInfo: { name: "health-code", version: "1" },
		appCapabilities: {},
	}).then((result) => {
		capabilities = (result.hostCapabilities ?? {}) as HostCapabilities
		applyTheme((result.hostContext ?? {}) as HostContext)
		post({ method: "ui/notifications/initialized", params: {} })

		// resize the frame with the page
		new ResizeObserver(() => {
			const { width, height } = document.documentElement.getBoundingClientRect()
			const params = { width: Math.ceil(width), height: Math.ceil(height) }
			post({ method: "ui/notifications/size-changed", params })
		}).observe(document.documentElement)
	})

	// expose the client to the screens
	return {
		canMessage: () => Boolean(capabilities.message),
		async callTool<Output>(name: string, input: Record<string, unknown>): Promise<Output> {
			const result: ToolResult = await request("tools/call", { name, arguments: input })
			if (result.isError || !result.structuredContent) {
				throw new Error(toErrorText(result))
			}
			return result.structuredContent as Output
		},

		// report a message that the client declines
		async sendMessage(text): Promise<void> {
			const result = await request("ui/message", { role: "user", content: [{ type: "text", text }] })
			if (result.isError) {
				throw new Error("The client did not accept the message.")
			}
		},
		openLink(url): void {
			if (url.startsWith("https://")) {
				void request("ui/open-link", { url }).catch(() => {})
			}
		},
	}
}

/**
 * Returns the error text of a tool result.
 */
export function toErrorText({ content }: ToolResult): string {
	return content?.find((item) => item.type === "text")?.text ?? requestFailed
}

/**
 * Describes a caught failure for the reader.
 */
export function toFailureText(error: unknown): string {
	return error instanceof Error ? error.message : requestFailed
}

function applyTheme({ theme }: HostContext): void {
	if (theme === "light" || theme === "dark") {
		document.documentElement.style.colorScheme = theme
	}
}
