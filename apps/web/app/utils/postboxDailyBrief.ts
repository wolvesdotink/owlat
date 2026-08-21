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

/**
 * A chunk's words, as the catalog key that carries them plus the values to
 * interpolate. This module is module scope and never calls `useI18n`; the brief
 * card is the render boundary that words each chunk.
 */
export type BriefText = string | { key: string; params?: Record<string, unknown> };

/** One renderable chunk: plain text, or an emphasized count linking somewhere. */
export type BriefSegment = { text: BriefText; to?: string };

/** A sentence is an ordered list of segments; the card renders them inline. */
export type BriefSentence = BriefSegment[];

/** Time-of-day serif greeting ("Good morning" before noon, etc.), as its key. */
export function briefGreeting(hour: number): string {
	if (hour < 12) return 'shared.postboxDailyBrief.greeting.morning';
	if (hour < 18) return 'shared.postboxDailyBrief.greeting.afternoon';
	return 'shared.postboxDailyBrief.greeting.evening';
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
		sentences.push([{ text: 'shared.postboxDailyBrief.newMail.allQuiet' }]);
	} else {
		const lead =
			counts.newMail <= 5
				? 'shared.postboxDailyBrief.newMail.leadQuiet'
				: 'shared.postboxDailyBrief.newMail.leadBusy';
		sentences.push([
			{ text: lead },
			{
				text: {
					key: 'shared.postboxDailyBrief.newMail.count',
					params: { count: counts.newMail },
				},
				to: BRIEF_LINK_TARGETS.newMail,
			},
			{ text: 'shared.postboxDailyBrief.newMail.tail' },
		]);
	}

	// 2 — what the agent already handled (only when it did anything).
	if (counts.drafted > 0 || counts.autoFiled > 0) {
		const parts: BriefSentence = [{ text: 'shared.postboxDailyBrief.agent.lead' }];
		if (counts.drafted > 0) {
			parts.push(
				{ text: 'shared.postboxDailyBrief.agent.drafted' },
				{
					text: {
						key: 'shared.postboxDailyBrief.agent.draftedCount',
						params: { count: counts.drafted },
					},
					to: BRIEF_LINK_TARGETS.drafts,
				},
				{ text: 'shared.postboxDailyBrief.agent.forReview' }
			);
		}
		if (counts.autoFiled > 0) {
			if (counts.drafted > 0) parts.push({ text: 'shared.postboxDailyBrief.agent.and' });
			parts.push({
				text: {
					key: 'shared.postboxDailyBrief.agent.filed',
					params: { count: counts.autoFiled },
				},
			});
		}
		parts.push({ text: 'shared.postboxDailyBrief.agent.overnight' });
		sentences.push(parts);
	}

	// 3 — what is blocked on the owner, and why answering matters.
	if (counts.questions > 0) {
		sentences.push([
			{
				text: {
					key: 'shared.postboxDailyBrief.questions.count',
					params: { count: counts.questions },
				},
				to: BRIEF_LINK_TARGETS.questions,
			},
			{
				// Two keys rather than one plural message: this clause opens with the
				// space that separates it from the count beside it, and the plural
				// splitter trims the forms it cuts apart.
				text:
					counts.questions === 1
						? 'shared.postboxDailyBrief.questions.tailOne'
						: 'shared.postboxDailyBrief.questions.tailOther',
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
