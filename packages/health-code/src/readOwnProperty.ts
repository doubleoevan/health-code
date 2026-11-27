/**
 * Reads an own property and returns undefined for an inherited one.
 */
export function readOwnProperty<Value>(record: Readonly<Record<string, Value>>, key: string): Value | undefined
export function readOwnProperty(record: unknown, key: string): unknown
export function readOwnProperty(record: unknown, key: string): unknown {
	const isRecord = typeof record === "object" && record !== null
	return isRecord && Object.hasOwn(record, key) ? (record as Record<string, unknown>)[key] : undefined
}
