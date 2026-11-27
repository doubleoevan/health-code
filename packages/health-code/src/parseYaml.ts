import { parse } from "yaml"

/**
 * Parses untrusted YAML without the duplicate key check, which compares every key in a map with every other.
 */
export function parseYaml(text: string): unknown {
	return parse(text, { uniqueKeys: false })
}
