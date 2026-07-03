/**
 * Pure draft-similarity used by the shadow scorecard to decide whether a human
 * approved essentially the SAME draft the agent would have auto-sent.
 *
 * Normalized token-level Levenshtein ratio: 1.0 = identical (after whitespace
 * normalization), 0.0 = fully different. Token-level (words, not characters)
 * keeps it cheap on realistic reply lengths and robust to reflowed whitespace,
 * while still penalizing real content edits. No LLM, no I/O — deterministic and
 * trivially testable.
 */

/** Normalize + tokenize a draft into comparable words. */
function tokenize(text: string): string[] {
	const trimmed = text.trim().toLowerCase();
	if (!trimmed) return [];
	return trimmed.split(/\s+/);
}

/** Word-level Levenshtein edit distance between two token sequences. */
function editDistance(a: string[], b: string[]): number {
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	// Two-row rolling DP: O(a.length) memory.
	let prev = new Array<number>(b.length + 1);
	let curr = new Array<number>(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;

	for (let i = 1; i <= a.length; i++) {
		curr[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const deletion = prev[j]! + 1;
			const insertion = curr[j - 1]! + 1;
			const substitution = prev[j - 1]! + cost;
			curr[j] = Math.min(deletion, insertion, substitution);
		}
		const tmp = prev;
		prev = curr;
		curr = tmp;
	}
	return prev[b.length]!;
}

/**
 * Similarity in [0, 1] between two drafts. Two blank drafts are treated as a
 * perfect match (1.0); a blank vs. non-blank is 0.0.
 */
export function draftSimilarity(a: string, b: string): number {
	if (a === b) return 1;
	const ta = tokenize(a);
	const tb = tokenize(b);
	const maxLen = Math.max(ta.length, tb.length);
	if (maxLen === 0) return 1; // both empty after normalization
	const distance = editDistance(ta, tb);
	return 1 - distance / maxLen;
}
