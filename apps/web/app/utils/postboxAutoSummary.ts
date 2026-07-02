/**
 * Eligibility predicate for the auto-summary strip (PostboxThreadReader).
 *
 * A thread is "long enough to summarize" when it has many messages OR a lot of
 * total body text — a single sprawling newsletter still benefits from a TL;DR,
 * while a 2-line back-and-forth does not. Pure + exported so the threshold is
 * unit-tested without mounting the reader.
 */

export const LONG_THREAD_MIN_MESSAGES = 5;
export const LONG_THREAD_MIN_BODY_CHARS = 8000;

export interface SummaryEligibleMessage {
	textBodyInline?: string;
	htmlBodyInline?: string;
	snippet?: string;
}

export function isLongThreadForSummary(messages: SummaryEligibleMessage[]): boolean {
	if (messages.length >= LONG_THREAD_MIN_MESSAGES) return true;
	const chars = messages.reduce(
		(sum, m) =>
			sum + (m.textBodyInline?.length ?? m.htmlBodyInline?.length ?? m.snippet?.length ?? 0),
		0,
	);
	return chars >= LONG_THREAD_MIN_BODY_CHARS;
}
