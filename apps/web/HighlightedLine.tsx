import { Highlight } from "prism-react-renderer"
import type { ReactElement } from "react"

// Leave token colors to the stylesheet so they follow the page theme.
const theme = { plain: {}, styles: [] }

export function HighlightedLine({ line, language }: { line: string; language: string }): ReactElement {
	return (
		<Highlight code={line} language={language} theme={theme}>
			{({ tokens, getTokenProps }) => (
				<>
					{tokens.flat().map((token, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: Tokens keep their order.
						<span key={`${index}:${token.content}`} className={getTokenProps({ token }).className}>
							{token.empty ? "" : token.content}
						</span>
					))}
				</>
			)}
		</Highlight>
	)
}
