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
 * equivalent release ("1.2.0-beta.1" < "1.2.0"). Between two pre-releases the
 * dot-separated identifiers are compared one by one the way semver spec §11
 * says: numeric identifiers numerically ("rc.10" > "rc.9"), alphanumeric ones
 * lexically, numeric below alphanumeric, and a shorter list of otherwise equal
 * identifiers below the longer one ("rc" < "rc.1").
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
	return comparePrerelease(pa.pre, pb.pre);
}

const NUMERIC_RE = /^\d+$/;

/** Order two non-empty pre-release suffixes identifier by identifier. */
function comparePrerelease(a: string, b: string): number {
	const as = a.split('.');
	const bs = b.split('.');
	const shared = Math.min(as.length, bs.length);
	for (let i = 0; i < shared; i++) {
		const ai = as[i] ?? '';
		const bi = bs[i] ?? '';
		if (ai === bi) continue;
		const aNumeric = NUMERIC_RE.test(ai);
		const bNumeric = NUMERIC_RE.test(bi);
		if (aNumeric && bNumeric) return Number(ai) > Number(bi) ? 1 : -1;
		// Numeric identifiers always sort below alphanumeric ones.
		if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
		return ai > bi ? 1 : -1;
	}
	return as.length === bs.length ? 0 : as.length > bs.length ? 1 : -1;
}
