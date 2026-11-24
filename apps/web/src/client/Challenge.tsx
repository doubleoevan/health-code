import { type ReactElement, useEffect, useRef } from "react"

type Widget = {
	render: (container: HTMLElement, options: Record<string, unknown>) => string
	remove: (id: string) => void
}
export function Challenge({
	siteKey,
	onToken,
	onFailure,
}: {
	siteKey: string
	onToken: (token: string) => void
	onFailure: () => void
}): ReactElement {
	const element = useRef<HTMLDivElement>(null)
	useEffect(() => {
		// Load verification only after a cache miss requires a new paid inspection.
		const script = document.createElement("script")
		script.onerror = onFailure
		script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
		let id: string | undefined
		const api = (): Widget | undefined => (window as Window & { turnstile?: Widget }).turnstile
		const render = (): void => {
			if (element.current) {
				id = api()?.render(element.current, {
					sitekey: siteKey,
					action: "inspect",
					callback: onToken,
					retry: "never",
					"error-callback": onFailure,
					"expired-callback": onFailure,
					"timeout-callback": onFailure,
					"unsupported-callback": onFailure,
				})
			}
		}
		if (api()) {
			render()
		} else {
			script.onload = render
			document.head.append(script)
		}
		return () => {
			script.onerror = null
			script.onload = null
			if (id) {
				api()?.remove(id)
			}
			script.remove()
		}
	}, [siteKey, onToken, onFailure])
	return <div className="challenge" ref={element} />
}
