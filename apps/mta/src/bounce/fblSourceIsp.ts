/**
 * The fixed set of feedback-loop operators a complaint report can be traced to,
 * and the mapping from free-text report hints onto it.
 */

/**
 * Every ISP token `isp()` can resolve.
 *
 * Exported because it is a CONTRACT, not an implementation detail:
 * `outcome.ts` maps each token onto the ramp's destination-provider cell axis,
 * and that mapping has to be TOTAL — a token with no row would silently drop
 * that ISP's complaints out of the cell axis. Declaring the tokens as a union
 * and requiring the map to `satisfies Record<FblSourceIspToken, …>` turns that
 * omission into a compile error instead of a hand-maintained test list.
 *
 * Each member MUST be a single `\w+` word: `reduceFbl()` in outcome.ts re-parses
 * the ISP out of the classification `message` with `/from (\w+)/`, and the ISP
 * becomes a bounded Prometheus label.
 */
export type FblSourceIspToken = 'microsoft' | 'yahoo' | 'aol' | 'comcast' | 'google' | 'mailru';

/**
 * Map a free-text hint (a feedback-report `User-Agent`, `Reported-Domain`, or
 * `Source-IP` reverse hint, or a `Received` trace line) to a known ISP token.
 *
 * This is intentionally a fixed enum of the large FBL providers rather than
 * free text — see `FblSourceIspToken`.
 */
export function isp(hint: string | undefined): FblSourceIspToken | undefined {
	if (!hint) return undefined;
	const lower = hint.toLowerCase();
	if (lower.includes('microsoft') || lower.includes('outlook') || lower.includes('hotmail')) {
		return 'microsoft';
	}
	if (lower.includes('yahoo')) return 'yahoo';
	if (lower.includes('aol')) return 'aol';
	if (lower.includes('comcast')) return 'comcast';
	if (lower.includes('google') || lower.includes('gmail')) return 'google';
	if (lower.includes('mail.ru')) return 'mailru';
	return undefined;
}

/**
 * Try to identify the source ISP from received headers. Kept as the last-resort
 * fallback for reports that carry no structured `User-Agent`/`Reported-Domain`.
 */
export function extractSourceIsp(receivedHeader: string): FblSourceIspToken | undefined {
	return isp(receivedHeader);
}
