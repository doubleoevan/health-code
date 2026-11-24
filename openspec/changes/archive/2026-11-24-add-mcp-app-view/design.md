# Design

## One self-contained page

The server offers `ui://health-code/view.html` as a resource with the MCP Apps content type. The page inlines its script and stylesheet and loads nothing from the network. It talks to the client through the MCP Apps messages and reads data only by calling this server's tools.

The tool result selects the screen. A result with dependencies opens the upgrade menu. A result with an inspection ID opens progress and results. The view keeps no data of its own, so reopening a conversation reads the saved report again.

## Patches stay with the coding agent

The view sends one chat message that names the inspection ID and the patch digest. Both values pass a format check. Repository text and release notes never enter that message. A client without chat messages gets the same request as text to copy.

## Untrusted text

Release notes and repository output render as text. Links open through the client and must use HTTPS.

## Client bridge

The page implements the few MCP Apps messages it uses. The official package adds a protocol runtime larger than the rest of the view. A manual browser check drives the page with the official host bridge.

## Missing settings

Model keys cannot travel through MCP forms. A tool call with missing settings returns one error that names each setting and the setup command. The coding agent and the app view show that error. Saved reports stay readable without settings.
