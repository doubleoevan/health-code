import { hydrateRoot } from "react-dom/client"
import { Page, type PageProps } from "./Page.tsx"
import "./style.css"

const root = document.getElementById("app")
const state = document.getElementById("page-state")
if (root && state?.textContent) {
	const props: PageProps = JSON.parse(state.textContent)
	hydrateRoot(root, <Page {...props} />)
}
