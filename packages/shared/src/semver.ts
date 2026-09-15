/**
 * One semver comparison for the whole repo.
 *
 * Three surfaces need to answer "is this release newer than what is running?":
 * the server's own update check (`apps/api/convex/systemUpdates.ts`), the
 * desktop update resolver (`apps/api/convex/desktop/updateResolver.ts`) and the
 * admin system page. They each used to carry their own copy, and the copies
 * disagreed — the admin page's ignored pre-release suffixes entirely, so
 * `1.2.0-rc.1` and `1.2.0` compared equal and an rc build looked current.
 *
 * The parser is deliberately tolerant: it accepts a leading `v`, missing minor
 * or patch components, and non-numeric junk (which reads as 0), because it is
 * fed release tags from GitHub as well as the locally stamped version. Callers
 * that need to REJECT a malformed version validate it first with
 * `isValidTargetVersion` from `./composeVerify`.
 */

/** A version split into its numeric components and its pre-release suffix. */
export interface ParsedSemver {
	parts: [number, number, number];
	/** The `-…` suffix without its leading dash; `''` for a release version. */
	pre: string;
}

/**
 * Split a version string into major/minor/patch plus its pre-release suffix.
 * Never throws: missing or non-numeric components read as 0.
 */
export function parseVersion(version: string): ParsedSemver {
	const clean = version.replace(/^v/, '').trim();
	const [main = '', pre = ''] = clean.split('-');
	const parts = main.split('.').map((part) => parseInt(part, 10) || 0);
	return {
		parts: [parts[0] || 0, parts[1] || 0, parts[2] || 0],
		pre,
	};
}

/**
 * Compare two semver strings.
 * Returns:
 *   +1 if a > b   (e.g. "1.2.4" > "1.2.3")
 *    0 if a == b
 *   -1 if a < b
 *
 * Tolerant of pre-release suffixes: a pre-release compares LESS than the
 * equivalent release ("1.2.0-beta.1" < "1.2.0"). Between two pre-releases,
 * the suffix is compared lexicographically.
 */
export function semverCompare(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	for (let i = 0; i < 3; i++) {
		const av = pa.parts[i] ?? 0;
		const bv = pb.parts[i] ?? 0;
		if (av !== bv) {
			return av > bv ? 1 : -1;
		}
	}
	// Pre-release < release (empty string beats any suffix)
	if (pa.pre === '' && pb.pre === '') return 0;
	if (pa.pre === '') return 1;
	if (pb.pre === '') return -1;
	return pa.pre > pb.pre ? 1 : pa.pre < pb.pre ? -1 : 0;
}
