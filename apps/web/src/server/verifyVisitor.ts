import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { isIP, SocketAddress } from "node:net"
import { AdmissionError, toUtcDay, type Visitor } from "./recordAdmissions.ts"

export function identifyVisitor(
	request: Request,
	secret: string,
	replay: boolean,
): { cookie: string; identity: Visitor } {
	const existing = /(?:^|;\s*)hc_visitor=([a-f0-9]{48})(?:;|$)/.exec(request.headers.get("cookie") ?? "")?.[1]
	const cookie = existing ?? randomBytes(24).toString("hex")
	const address = request.headers.get("x-envoy-external-address") ?? (replay ? "127.0.0.1" : "")
	if (!isIP(address)) {
		throw new AdmissionError(503, "Visitor verification is temporarily unavailable.")
	}

	// Canonicalize the ingress address before deriving its daily quota bucket.
	const isVersion6 = isIP(address) === 6
	const canonical = new SocketAddress({ address, family: isVersion6 ? "ipv6" : "ipv4" }).address

	// count one IPv6 subscriber, who holds a whole /64, as one network
	const ip = isVersion6 ? toNetworkPrefix(canonical) : canonical
	const digest = (value: string): string => createHmac("sha256", secret).update(value).digest("hex")
	const day = toUtcDay()
	return { cookie, identity: { visitor: digest(`visitor:${cookie}`), network: digest(`network:${day}:${ip}`) } }
}

// keep the first four groups of an IPv6 address, written in full
function toNetworkPrefix(address: string): string {
	const [head = "", tail = ""] = address.split("::")
	const headGroups = head ? head.split(":") : []
	const tailGroups = tail ? tail.split(":") : []
	const zeroGroups = Array.from({ length: 8 - headGroups.length - tailGroups.length }, () => "0")
	const groups = address.includes("::") ? [...headGroups, ...zeroGroups, ...tailGroups] : headGroups
	return groups.slice(0, 4).join(":")
}

export async function verifyChallenge(
	token: unknown,
	secret: string,
	hostname: string,
	request: (...args: Parameters<typeof fetch>) => Promise<Response> = fetch,
): Promise<void> {
	if (typeof token !== "string" || !token.length || token.length > 2048) {
		throw new AdmissionError(403, "Complete the verification and retry.")
	}
	const response = await request("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		body: new URLSearchParams({ secret, response: token }),
		redirect: "error",
		signal: AbortSignal.timeout(8000),
	}).catch(() => null)
	if (!response?.ok) {
		await response?.body?.cancel()
		throw new AdmissionError(503, "Verification is temporarily unavailable. Retry or run Health Code in CI.")
	}

	// Bind the single-use response to this hostname and form action.
	const result = await response.json()
	if (result.success !== true || result.hostname !== hostname || result.action !== "inspect") {
		throw new AdmissionError(403, "Verification expired or failed. Retry the inspection.")
	}
}

export function isSecureRequest(request: Request, origin?: string): boolean {
	const url = new URL(request.url)
	return (
		// Recognize TLS forwarded by the configured ingress.
		url.protocol === "https:" ||
		(origin === `https://${url.host}` &&
			request.headers.get("x-forwarded-proto") === "https" &&
			isIP(request.headers.get("x-envoy-external-address") ?? "") !== 0)
	)
}

export function verifyAdmin(request: Request, password?: string, origin?: string): boolean {
	if (!password || !isSecureRequest(request, origin)) {
		return false
	}

	// Require the configured credentials before processing Basic authentication.
	const auth = request.headers.get("Authorization")
	if (!auth?.startsWith("Basic ")) {
		return false
	}

	// Compare fixed-length digests so even a wrong-length password follows the same path.
	const digest = (value: string): Buffer => createHash("sha256").update(value).digest()
	const supplied = Buffer.from(auth.slice(6), "base64").toString("utf8")
	return timingSafeEqual(digest(supplied), digest(`admin:${password}`))
}
