import { InspectionError } from "./contracts.ts"

export const registryHosts = ["registry.npmjs.org", "registry.yarnpkg.com"] as const
export function validateRegistryHosts(hosts: readonly string[]): void {
	if (!hosts.length || hosts.some((host) => !registryHosts.some((registry) => registry === host))) {
		throw new InspectionError("policy", "Unsupported registry policy")
	}
}
export function confirmNetworkPolicy(
	hosts: readonly string[],
	policy: { mode: string; allowedHosts: readonly string[]; deniedHosts: readonly string[] },
): void {
	if (
		policy.mode !== "allowlist" ||
		policy.deniedHosts.length ||
		JSON.stringify([...hosts].sort()) !== JSON.stringify([...policy.allowedHosts].sort())
	) {
		throw new InspectionError("policy", "Sandbox network policy mismatch")
	}
}
