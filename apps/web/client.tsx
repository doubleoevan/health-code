import { hydrateRoot } from "react-dom/client"
import { Page, type PageProps } from "./Page.tsx"
import "./style.css"

// locate the server-rendered page and its serialized state
const root = document.getElementById("app")
const state = document.getElementById("page-state")
if (root && state?.textContent) {
	// hydrate the existing page with the same snapshot
	const props: PageProps = JSON.parse(state.textContent)
	hydrateRoot(root, <Page {...props} />)
}
