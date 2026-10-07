/**
 * What a thread list row says instead of its snippet once the thread is
 * interpreted (SPEC §7, plan §4.1): the top open item.
 *
 *   "4 for you · Approve the revised quote by Fri"
 *   "1 to do · Pay €38.08 by 21 Oct · no reply needed"
 *   "waiting · She sends the floor plan by Mon"
 *
 * A row without an open item keeps its snippet. A shared mailbox's row shows
 * the item AND the raw snippet, never a summary. Pure: labels are catalog keys.
 */
import type { BriefTopRow } from '../../../api/convex/mail/interpret/briefTop';
import { briefDueDate } from '~/utils/threadBriefContext';

export interface BriefRowLine {
	/** "{count} for you" / "{count} to do" / "waiting". */
	leadKey: string;
	count: number;
	/** The count as shown: "2000+" when the thread has more than were counted. */
	countText: string;
	tone: 'brand' | 'info';
	text: string;
	/** "Fri", "21 Oct": already formatted for the locale. */
	due: string | null;
	/** Something to do, but the thread needs no answer. */
	isNoReplyNeeded: boolean;
	/** A shared mailbox: the snippet stays beside the item. */
	keepsSnippet: boolean;
}

export function briefRowLine(
	top: BriefTopRow | undefined,
	locale: string,
	now: number = Date.now()
): BriefRowLine | null {
	const item = top?.top;
	if (!top || !item) return null;
	const text = locale.toLowerCase().startsWith('de') ? item.text.de : item.text.en;
	if (!text.trim()) return null;
	const isWaiting = item.responsibility === 'them' || top.forYou === 0;
	const due = item.dueAt !== undefined ? briefDueDate(item.dueAt, locale, now) : null;
	return {
		leadKey: isWaiting
			? 'components.brief.row.waiting'
			: top.isReplyNeeded
				? 'components.brief.row.forYou'
				: 'components.brief.row.toDo',
		count: isWaiting ? top.waiting : top.forYou,
		countText: `${isWaiting ? top.waiting : top.forYou}${top.isCapped ? '+' : ''}`,
		tone: isWaiting ? 'info' : 'brand',
		text,
		due,
		isNoReplyNeeded: !isWaiting && !top.isReplyNeeded,
		keepsSnippet: top.mode === 'actions',
	};
}

/** The brief's first "Latest update" line in the UI locale, when the row has one. */
export function briefRowLatest(top: BriefTopRow | undefined, locale: string): string | null {
	const latest = top?.latest;
	if (!latest) return null;
	return (locale.toLowerCase().startsWith('de') ? latest.de : latest.en).trim() || null;
}
