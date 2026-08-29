/**
 * Bounded Levenshtein distance, shared because the same question is asked from
 * both ends of the mail path:
 *
 *   • inbound (`apps/api/convex/mail/senderHeuristics.ts`) — is this From domain
 *     a near-miss of a domain a real contact uses (`paypa1.com` for
 *     `paypal.com`)?
 *   • outbound (`apps/web/app/utils/recipientTypo.ts`) — is the domain just
 *     typed a near-miss of one the user actually writes to (`gmial.com`)?
 *
 * Both need the identical notion of "one or two single-character slips", so the
 * function lives here rather than in two copies that can drift apart.
 */

/**
 * Levenshtein edit distance between `a` and `b`, with an early exit at `max`.
 * Returns `max + 1` (not the true distance) as soon as the pair is known to be
 * further apart than `max` — callers only ever compare against the bound.
 *
 * Inputs are small (domain strings), so the full O(n·m) table is fine; the
 * bound just avoids finishing a comparison whose answer cannot matter.
 */
export function boundedEditDistance(a: string, b: string, max: number): number {
	if (a === b) return 0;
	if (Math.abs(a.length - b.length) > max) return max + 1;
	const prev: number[] = Array.from({ length: b.length + 1 }, () => 0);
	const curr: number[] = Array.from({ length: b.length + 1 }, () => 0);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		let rowMin = curr[0]!;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
			if (curr[j]! < rowMin) rowMin = curr[j]!;
		}
		if (rowMin > max) return max + 1;
		for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
	}
	return prev[b.length]!;
}

/**
 * A near-miss is 1–2 single-character edits (`paypa1.com` → `paypal.com`). Zero
 * is an exact match (the real thing — never a look-alike) and 3+ is too far to
 * be a deliberate look-alike or a plausible typo without drowning in false
 * positives.
 */
export const LOOKALIKE_MAX_EDITS = 2;
