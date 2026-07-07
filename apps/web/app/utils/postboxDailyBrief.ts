/**
 * Daily Brief card copy — pure, deterministic template assembly for
 * PostboxDailyBrief.vue. The backend (mail/brief.ts) caches grounded COUNTS;
 * this module turns them into at most three human sentences where every
 * concrete count is a link to the surface holding the real rows:
 *
 *   - new mail        → the Today section (#postbox-today)
 *   - drafts to review → the Reply Queue page (review & send)
 *   - questions        → the For-you section (#postbox-for-you)
 *
 * Copy rules (shared UX brief): human language only — no AI jargon, no raw
 * confidence numbers, no emoji; counts read in weight-550; one muted line of
 * WHY ("answering them unblocks…") rides inside the sentence itself.
 */

/** Where each linked count routes. Same-page anchors keep focus in the flow. */
export const BRIEF_LINK_TARGETS = {
	newMail: '#postbox-today',
	drafts: '/dashboard/postbox/reply-queue',
	questions: '#postbox-for-you',
} as const;

export interface DailyBriefCounts {
	newMail: number;
	drafted: number;
	questions: number;
	autoFiled: number;
}

/** One renderable chunk: plain text, or an emphasized count linking somewhere. */
export type BriefSegment = { text: string; to?: string };

/** A sentence is an ordered list of segments; the card renders them inline. */
export type BriefSentence = BriefSegment[];

/** Time-of-day serif greeting ("Good morning" before noon, etc.). */
export function briefGreeting(hour: number): string {
	if (hour < 12) return 'Good morning';
	if (hour < 18) return 'Good afternoon';
	return 'Good evening';
}

function plural(n: number, singular: string, pluralWord?: string): string {
	return n === 1 ? singular : (pluralWord ?? `${singular}s`);
}

/**
 * Compose the card body: <= 3 sentences, empty sections simply drop out.
 *
 *   "Quiet day: 4 new since this morning. Your agent drafted 3 replies and
 *    filed 6 low-priority emails overnight. 2 questions need you — answering
 *    them unblocks the waiting replies."
 */
export function composeBriefSentences(counts: DailyBriefCounts): BriefSentence[] {
	const sentences: BriefSentence[] = [];

	// 1 — new mail since local midnight (always present: it frames the day).
	if (counts.newMail === 0) {
		sentences.push([{ text: 'All quiet — nothing new since this morning.' }]);
	} else {
		const lead = counts.newMail <= 5 ? 'Quiet day: ' : 'Busy morning: ';
		sentences.push([
			{ text: lead },
			{ text: `${counts.newMail} new`, to: BRIEF_LINK_TARGETS.newMail },
			{ text: ' since this morning.' },
		]);
	}

	// 2 — what the agent already handled (only when it did anything).
	if (counts.drafted > 0 || counts.autoFiled > 0) {
		const parts: BriefSentence = [{ text: 'Your agent ' }];
		if (counts.drafted > 0) {
			parts.push(
				{ text: 'drafted ' },
				{
					text: `${counts.drafted} ${plural(counts.drafted, 'reply', 'replies')}`,
					to: BRIEF_LINK_TARGETS.drafts,
				},
				{ text: ' for review' }
			);
		}
		if (counts.autoFiled > 0) {
			if (counts.drafted > 0) parts.push({ text: ' and ' });
			parts.push({
				text: `filed ${counts.autoFiled} low-priority ${plural(counts.autoFiled, 'email')}`,
			});
		}
		parts.push({ text: ' overnight.' });
		sentences.push(parts);
	}

	// 3 — what is blocked on the owner, and why answering matters.
	if (counts.questions > 0) {
		sentences.push([
			{
				text: `${counts.questions} ${plural(counts.questions, 'question')}`,
				to: BRIEF_LINK_TARGETS.questions,
			},
			{
				text: `${counts.questions === 1 ? ' needs' : ' need'} you — answering ${
					counts.questions === 1 ? 'it' : 'them'
				} unblocks the waiting replies.`,
			},
		]);
	}

	return sentences;
}

/** The viewer-local calendar day (YYYY-MM-DD) — the cache/dismissal key. */
export function localDayOf(date: Date): string {
	const y = date.getFullYear();
	const m = `${date.getMonth() + 1}`.padStart(2, '0');
	const d = `${date.getDate()}`.padStart(2, '0');
	return `${y}-${m}-${d}`;
}

/** The viewer-local midnight timestamp for the same day. */
export function localDayStartOf(date: Date): number {
	const start = new Date(date);
	start.setHours(0, 0, 0, 0);
	return start.getTime();
}
