type JsonEditor = Pick<typeof import("jsonc-parser"), "applyEdits" | "modify">
type JsonChange = { path: (string | number)[]; value: unknown }

/**
 * Applies manifest changes to the original text with the caller's JSON editor.
 */
export function applyManifestChanges(editor: JsonEditor, original: string, manifest: object): string {
	const formattingOptions = {
		insertSpaces: !/^\t/m.test(original),
		tabSize: /^( +)\S/m.exec(original)?.[1]?.length ?? 2,
		eol: original.includes("\r\n") ? "\r\n" : "\n",
	}

	// rewrite only the values that differ
	return findChanges(JSON.parse(original), manifest).reduce(
		(text, { path, value }) => editor.applyEdits(text, editor.modify(text, path, value, { formattingOptions })),
		original,
	)
}

function findChanges(before: unknown, after: unknown, path: JsonChange["path"] = []): JsonChange[] {
	if (isRecord(before) && isRecord(after)) {
		const keys = new Set([...Object.keys(before), ...Object.keys(after)])
		return [...keys].flatMap((key) => findChanges(before[key], after[key], [...path, key]))
	}
	return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ path, value: after }]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
