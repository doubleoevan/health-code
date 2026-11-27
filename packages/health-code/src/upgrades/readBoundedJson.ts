export class ResponseTooLargeError extends Error {}

export const mebibyte = 1024 * 1024

/**
 * Cancels oversized response bodies before decoding their JSON.
 */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	return JSON.parse(await readBoundedText(response, maxBytes))
}

/**
 * Reads a response body as text and cancels it once it passes the size limit.
 */
export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
	const reader = response.body?.getReader()
	if (!reader) {
		throw new Error("Empty metadata response")
	}

	// decode the body while counting its bytes
	const decoder = new TextDecoder()
	let text = ""
	let bytes = 0
	try {
		// stream the response while tracking its cumulative size
		for (;;) {
			const { value, done } = await reader.read()
			if (done) {
				break
			}
			bytes += value.byteLength

			// cancel oversized responses before decoding the json
			if (bytes > maxBytes) {
				await reader.cancel()
				throw new ResponseTooLargeError("Metadata exceeds the size limit")
			}

			// decode each chunk as it arrives, so the bytes are never held twice
			text += decoder.decode(value, { stream: true })
		}
	} finally {
		reader.releaseLock()
	}

	// flush the decoder after releasing the reader
	return text + decoder.decode()
}
