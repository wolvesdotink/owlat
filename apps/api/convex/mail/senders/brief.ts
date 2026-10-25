/**
 * The Senders line of the Daily Brief, once a week (Monday, UTC):
 *
 *   - how many senders are waiting on the Senders page's To review tab
 *     ("rarely read senders"), and
 *   - up to three "you open everything from X in Updates" lines: a `keep`
 *     sender whose mail lands in Updates (notification / receipt) and that the
 *     person opens nearly always, which they may want in Today instead.
 *
 * Only ever a suggestion: nothing here changes a status (§4.3). Reads the
 * same bounded `keep` scan as the page; personal mailboxes only.
 */

import type { Doc } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { isPersonalMailbox } from '../permissions';
import { senderWindowTotals } from './counters';
import { listSenderSuggestions, SUGGEST_MIN_DELIVERED, SUGGESTION_SCAN } from './suggestions';

/** Monday: the weekday the line rides along (getUTCDay numbering). */
const WEEKLY_BRIEF_DAY = 1;

/** "Opens everything": the read rate a sender in Updates must reach. */
export const OPENS_EVERYTHING_RATE = 0.9;

/** "You open everything from X" lines per brief. */
const OPENED_IN_UPDATES_MAX = 3;

/** The categories whose mail is placed in Updates (§2.8 step 6). */
const UPDATES_KINDS: ReadonlySet<string> = new Set(['notification', 'receipt']);

export interface SenderBriefLine {
	rarelyRead: number;
	openedInUpdates: { address: string; displayName?: string }[];
}

export function isWeeklySenderBriefDay(now: number): boolean {
	return new Date(now).getUTCDay() === WEEKLY_BRIEF_DAY;
}

/** Pure: a `keep` sender in Updates that the person opens nearly always. */
export function opensEverythingInUpdates(
	profile: Pick<
		Doc<'mailSenderProfiles'>,
		'status' | 'kind' | 'placementOverride' | 'weekAnchor' | 'deliveredWeeks' | 'openedWeeks'
	>,
	now: number
): boolean {
	if (profile.status !== 'keep' || profile.placementOverride !== undefined) return false;
	if (!profile.kind || !UPDATES_KINDS.has(profile.kind)) return false;
	const totals = senderWindowTotals(profile, now);
	return totals.delivered >= SUGGEST_MIN_DELIVERED && totals.readRate >= OPENS_EVERYTHING_RATE;
}

/** The weekly line, or null on other days, for team inboxes, or when it would be empty. */
export async function weeklySenderBriefLine(
	ctx: Pick<QueryCtx, 'db'>,
	mailbox: Doc<'mailboxes'>,
	now: number
): Promise<SenderBriefLine | null> {
	if (!isWeeklySenderBriefDay(now) || !isPersonalMailbox(mailbox)) return null;
	const rarelyRead = (await listSenderSuggestions(ctx, mailbox._id, now)).length;
	const keep = await ctx.db
		.query('mailSenderProfiles')
		.withIndex('by_mailbox_status_last', (q) => q.eq('mailboxId', mailbox._id).eq('status', 'keep'))
		.order('desc')
		.take(SUGGESTION_SCAN);
	const openedInUpdates = keep
		.filter((profile) => opensEverythingInUpdates(profile, now))
		.slice(0, OPENED_IN_UPDATES_MAX)
		.map((profile) => ({
			address: profile.address,
			...(profile.displayName ? { displayName: profile.displayName } : {}),
		}));
	if (rarelyRead === 0 && openedInUpdates.length === 0) return null;
	return { rarelyRead, openedInUpdates };
}
