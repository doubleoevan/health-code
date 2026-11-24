/**
 * Cancels oversized response bodies before decoding their JSON.
 */
export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
	const reader = response.body?.getReader()
	if (!reader) {
		throw new Error("Empty metadata response")
	}
	const chunks: Uint8Array[] = []
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
				throw new Error("Metadata exceeds the size limit")
			}

			// accumulate only chunks within the response budget
			chunks.push(value)
		}
	} finally {
		reader.releaseLock()
	}

	// parse the completed response after releasing the reader
	return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}
