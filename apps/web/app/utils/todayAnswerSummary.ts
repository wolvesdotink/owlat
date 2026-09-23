/**
 * The two lines under Today's "N need an answer" number.
 *
 * The first line breaks N down by where each item came from — personal and
 * shared inboxes, the team inbox, chat mentions — so its parts always add up
 * to N. What can be said ACROSS those sources (how many already have a draft,
 * roughly how long the queue takes) goes on the second line; mixing the two
 * made "2 with drafts ready · 3 emails" read as if 5 were 5 different things.
 *
 * Module scope, so it hands back message keys with their params; the card
 * resolves them. Counts are always digits (the catalog forms say `{count}`).
 */

export interface AnswerCounts {
	mail: number;
	team: number;
	mention: number;
	drafts: number;
}

export interface SummaryPart {
	key: string;
	count: number;
}

/** A rough reading-and-replying budget: ~90 seconds a card, at least a minute. */
export function answerMinutes(total: number): number {
	return Math.max(1, Math.round(total * 1.5));
}

/** Line one: the total split by source. Empty sources are left out. */
export function answerSourceParts(counts: AnswerCounts): SummaryPart[] {
	const parts: SummaryPart[] = [];
	if (counts.mail > 0) parts.push({ key: 'components.today.answer.mail', count: counts.mail });
	if (counts.team > 0) parts.push({ key: 'components.today.answer.team', count: counts.team });
	if (counts.mention > 0)
		parts.push({ key: 'components.today.answer.mentions', count: counts.mention });
	return parts;
}

/** Line two: drafts that are ready (when any) and the time estimate. */
export function answerEffortParts(counts: AnswerCounts, total: number): SummaryPart[] {
	const parts: SummaryPart[] = [];
	if (counts.drafts > 0)
		parts.push({ key: 'components.today.answer.drafts', count: counts.drafts });
	parts.push({ key: 'components.today.answer.minutes', count: answerMinutes(total) });
	return parts;
}
