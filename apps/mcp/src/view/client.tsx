import { type ReactElement, StrictMode, useState, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { CurrentStep } from "./CurrentStep.tsx"
import { connectHost, type ToolResult, toErrorText } from "./connectHost.ts"
import { InspectionView } from "./InspectionView.tsx"
import { toRepositoryName } from "./labels.ts"
import { type Menu, UpgradeMenu } from "./UpgradeMenu.tsx"

type Screen =
	| { kind: "waiting"; text: string }
	| { kind: "failed"; text: string }
	| { kind: "menu"; menu: Menu; input: Record<string, unknown> }
	| { kind: "inspection"; inspectionId: string }

// remember the filters behind the page that the tool result shows
let toolInput: Record<string, unknown> = {}

// hold the screen outside React for the client bridge
let latestScreen: Screen = { kind: "waiting", text: "Waiting for Health Code…" }
let onScreenChange: () => void = () => {}
function handleScreen(screen: Screen): void {
	latestScreen = screen
	onScreenChange()
}
function subscribeToScreen(onChange: () => void): () => void {
	onScreenChange = onChange
	return () => {
		onScreenChange = () => {}
	}
}

// select the screen from the client's messages
const host = connectHost({
	onToolInput(input) {
		toolInput = input
		const { repositoryUrl } = input
		const name = typeof repositoryUrl === "string" ? toRepositoryName(repositoryUrl) : undefined
		handleScreen({ kind: "waiting", text: name ? `Reading ${name}…` : "Working…" })
	},
	onToolResult: (result) => handleScreen(toScreen(result)),
	onToolCancelled: () => handleScreen({ kind: "failed", text: "The request was cancelled." }),
})

function toScreen(result: ToolResult): Screen {
	const details = result.structuredContent
	if (result.isError || !details) {
		return { kind: "failed", text: toErrorText(result) }
	}

	// tell the upgrade menu apart from one inspection
	return Array.isArray(details.dependencies)
		? { kind: "menu", menu: details as Menu, input: toolInput }
		: { kind: "inspection", inspectionId: String(details.inspectionId) }
}

function App(): ReactElement {
	const screen = useSyncExternalStore(subscribeToScreen, () => latestScreen)
	const [selected, setSelected] = useState<{ screen: Screen; inspectionId: string }>()

	// choose the inspection to show
	const selectedInspectionId = selected?.screen === screen ? selected.inspectionId : undefined
	const inspectionId = screen.kind === "inspection" ? screen.inspectionId : selectedInspectionId
	return (
		<main>
			{/* waiting or failed request */}
			{screen.kind === "waiting" && <CurrentStep text={screen.text} />}
			{screen.kind === "failed" && <p role="alert">{screen.text}</p>}

			{/* upgrade menu kept mounted behind a selected inspection */}
			{screen.kind === "menu" && (
				<div hidden={Boolean(selectedInspectionId)}>
					<UpgradeMenu
						key={screen.menu.upgradeMenuId}
						host={host}
						firstPage={screen.menu}
						input={screen.input}
						isHidden={Boolean(selectedInspectionId)}
						onInspect={(inspectionId) => setSelected({ screen, inspectionId })}
					/>
				</div>
			)}

			{/* one inspection */}
			{inspectionId && (
				<InspectionView
					key={inspectionId}
					host={host}
					inspectionId={inspectionId}
					onBack={selectedInspectionId ? () => setSelected(undefined) : undefined}
				/>
			)}
		</main>
	)
}

// mount the page after the client bridge is listening
const root = document.getElementById("root")
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	)
}
