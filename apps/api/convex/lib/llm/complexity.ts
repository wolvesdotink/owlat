/**
 * Sub-millisecond, no-LLM heuristic for how complex a piece of *user-controlled*
 * text is, so a clearly-trivial request can be routed to a cheaper model. Two
 * rules, borrowed from spacebot's prompt router, keep this safe:
 *   1. Score ONLY user-controlled text — never the system prompt / context.
 *   2. Ambiguous text keeps the default (capable) model — quality never silently
 *      drops on a borderline request; only obviously-trivial text downgrades.
 */

/** Complexity in [0, 1]: 0 = trivial ("thanks!"), 1 = involved (code, multi-part). */
export function scoreComplexity(text: string): number {
	const t = text.trim();
	if (t === '') return 0;
	const words = t.split(/\s+/).length;

	let score = 0;
	// Length — short asks are simpler (saturates around 40 words).
	score += Math.min(words / 40, 1) * 0.5;
	// Multiple sentences/questions mean more to reason about.
	const sentences = (t.match(/[.!?]+/g) ?? []).length;
	score += Math.min(sentences / 4, 1) * 0.2;
	// Code / markup / structured payloads → keep the capable model.
	if (/```|<\/?[a-z][\s\S]*?>|[{};]|\bfunction\b|\bSELECT\b|\bimport\b/i.test(t)) score += 0.4;
	// Multi-part / analytical asks add complexity.
	if (/\b(and also|additionally|furthermore|step by step|compare|analy[sz]e|explain why)\b/i.test(t)) score += 0.2;
	// Trivial acknowledgements / one-liners pull the score down.
	if (
		words <= 8 &&
		/\b(thanks?|thank you|ok|okay|got it|sounds good|will do|noted|yep|yes|no|fix (a )?typo|one[- ]?liner)\b/i.test(t)
	) {
		score -= 0.3;
	}

	return Math.max(0, Math.min(1, score));
}

/** At or below this score, text is "clearly trivial" and may be downgraded. */
export const COMPLEXITY_DOWNGRADE_THRESHOLD = 0.2;

/** Whether the user's text is trivial enough to route to the cheaper model. */
export function isTrivialUserText(text: string): boolean {
	return scoreComplexity(text) <= COMPLEXITY_DOWNGRADE_THRESHOLD;
}
