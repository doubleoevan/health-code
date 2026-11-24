import { readFile } from "node:fs/promises"
import type { McpServer } from "@modelcontextprotocol/server"

const appViewUri = "ui://health-code/view.html"
const contentType = "text/html;profile=mcp-app"

// include the earlier key for clients that read it
export const appViewMeta = { ui: { resourceUri: appViewUri }, "ui/resourceUri": appViewUri }

/**
 * Registers the interactive page that supporting clients show with a tool result.
 */
export function registerAppView(server: McpServer): void {
	const config = { title: "Health Code", mimeType: contentType, _meta: { ui: { prefersBorder: true } } }
	server.registerResource("app-view", appViewUri, config, async (uri) => ({
		contents: [{ uri: uri.href, mimeType: contentType, text: await readPage(), _meta: config._meta }],
	}))
}

async function readPage(): Promise<string> {
	// read the bundle that the build writes beside this module
	const [script, style] = await Promise.all(
		["client.js", "style.css"].map((name) => readFile(new URL(`./view/${name}`, import.meta.url), "utf8")),
	)

	// keep bundled text from closing its inline element
	const inlineScript = script?.replaceAll("</script", "<\\/script").replaceAll("<!--", "<\\!--")
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Health Code</title><style>${style}</style></head>
<body><div id="root"></div><script>${inlineScript}</script></body>
</html>`
}
