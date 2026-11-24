/**
 * Checks whether a module path names a package or one of its subpaths.
 */
export function isPackagePath({ path, dependency }: { path: string; dependency: string }): boolean {
	return path === dependency || path.startsWith(`${dependency}/`)
}
