/**
 * Formats the hour and minute of an ISO timestamp in UTC.
 */
export function toUtcTime(isoTimestamp: string): string {
	return `${isoTimestamp.slice(11, 16)} UTC`
}
