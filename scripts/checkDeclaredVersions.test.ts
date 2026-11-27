import { expect, test } from "bun:test"
import { toDeclaredVersionViolations } from "./checkDeclaredVersions.ts"

const declaredVersions = {
	bunVersion: "1.4.3\n",
	manifest: { packageManager: "bun@1.4.3", patchedDependencies: { "@example/parser@1.0.0": "patches/parser.patch" } },
	lockText: '{"packages":{"@example/parser":["@example/parser@1.0.0","",{}, "sha512-fixture"],},}',
}

test("matching Bun versions and an installed patch version pass", () => {
	expect(toDeclaredVersionViolations(declaredVersions)).toEqual([])
})
test("Bun version drift and a stale patch both fail", () => {
	expect(
		toDeclaredVersionViolations({
			...declaredVersions,
			bunVersion: "1.4.4",
			lockText: declaredVersions.lockText.replace("@1.0.0", "@1.1.0"),
		}),
	).toEqual([
		"patchedDependencies names @example/parser@1.0.0, which bun.lock does not install",
		"packageManager must match .bun-version (bun@1.4.4)",
	])
})
test("a missing package map fails closed", () => {
	expect(() => toDeclaredVersionViolations({ ...declaredVersions, lockText: "{}" })).toThrow()
})
