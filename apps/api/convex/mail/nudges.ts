/**
 * Follow-up nudges (SPEC §7): a "Waiting on others" item that went stale
 * shows in the Answer queue as a follow-up card offering "Draft a nudge".
 *
 * Derived when the queue is read, from what is already stored: the thread
 * brief's open items the other side owes (`threadItems`, responsibility
 * `them`, read off `by_mailbox_responsibility_due`) and the thread's newest
 * messages. No cron and no new rows. Because nothing is written when an item
 * goes stale, a card appears the next time the queue query runs, not at the
 * exact minute.
 *
 * An item asks for a nudge ({@link nudgeVerdict}):
 *
 *  - **overdue**: it has a resolved due date and that date passed;
 *  - **stale**: it has none, and 3 business days (Monday to Friday, UTC)
 *    passed since it was asked.
 *
 * A reply from them cancels it: an inbound message newer than the ask (for a
 * dated item, newer than the due date, so "working on it" before the
 * deadline does not). A message of ours since the ask (a nudge already sent)
 * moves the clock to 3 business days after it.
 *
 * Personal mailboxes only. Skipped: unconfirmed proposals, muted threads, and
 * threads whose interpretation is fenced off (`interpret/staleFence.ts`):
 * their items are not the model's to act on. A thread the queue already
 * shows (needs-reply or a "Remind me" follow-up) gets no second card; its
 * follow-up card offers the nudge itself.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { normalizeEmail } from '@owlat/shared';
import { DAY_MS } from '../lib/constants';
import { isThreadMuted } from '../lib/mailMute';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { isPersonalMailbox } from './permissions';
import { isFencedThread } from './interpret/staleFence';

/** Business days a dateless waiting item waits before it asks for a nudge. */
export const NUDGE_AFTER_BUSINESS_DAYS = 3;
/** Nudge cards one queue read shows at most. */
export const NUDGE_LIMIT = 20;
/** Items one scan reads before it stops. */
export const NUDGE_SCAN_BUDGET = 200;
/** Newest messages of a thread read for the reply check. */
const THREAD_MESSAGE_SCAN = 10;

export type NudgeReason = 'overdue' | 'stale';

/** What a follow-up card offers: a nudge for a stale item, or for a "Remind me" reminder. */
export type QueueNudge =
	| { reason: NudgeReason; itemId: Id<'threadItems'>; dueAt?: number }
	| { reason: 'reminder' };

/** `at` plus `days` business days (Monday to Friday, UTC), at the same time of day. Pure. */
export function addBusinessDays(at: number, days: number): number {
	let next = at;
	let left = days;
	while (left > 0) {
		next += DAY_MS;
		const weekday = new Date(next).getUTCDay();
		if (weekday !== 0 && weekday !== 6) left--;
	}
	return next;
}

export interface NudgeSignals {
	/** The item's resolved due date. */
	dueAt?: number | undefined;
	/** When it was asked (the first evidence's message date). */
	askedAt: number;
	/** The thread's newest message of ours. */
	lastOwnAt?: number | undefined;
	/** The thread's newest message from someone else. */
	lastInboundAt?: number | undefined;
	now: number;
}

/** Whether a waiting item asks for a nudge now, and since when. Pure (see the module header). */
export function nudgeVerdict(s: NudgeSignals): { reason: NudgeReason; at: number } | null {
	const cancelAfter = s.dueAt !== undefined ? Math.max(s.askedAt, s.dueAt) : s.askedAt;
	if (s.lastInboundAt !== undefined && s.lastInboundAt > cancelAfter) return null;
	const reason: NudgeReason = s.dueAt !== undefined ? 'overdue' : 'stale';
	let at = s.dueAt ?? addBusinessDays(s.askedAt, NUDGE_AFTER_BUSINESS_DAYS);
	if (s.lastOwnAt !== undefined && s.lastOwnAt > s.askedAt) {
		at = Math.max(at, addBusinessDays(s.lastOwnAt, NUDGE_AFTER_BUSINESS_DAYS));
	}
	return s.now >= at ? { reason, at } : null;
}

export interface NudgeQueueRow {
	thread: Doc<'mailThreads'>;
	item: Doc<'threadItems'>;
	/** The message the nudge follows up on: our newest, else the thread's newest. */
	message: Doc<'mailMessages'>;
	reason: NudgeReason;
	/** When the item started asking for a nudge. */
	since: number;
}

function openWaitingItems(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	now: number,
	isDated: boolean
): AsyncIterable<Doc<'threadItems'>> {
	return ctx.db.query('threadItems').withIndex('by_mailbox_responsibility_due', (q) => {
		const open = q.eq('mailboxId', mailboxId).eq('responsibility', 'them').eq('status', 'open');
		// Dated items only once their date passed; a future deadline is not nudged.
		return isDated ? open.gte('due.at', 0).lt('due.at', now) : open.eq('due.at', undefined);
	});
}

async function ownAddressesOf(
	ctx: Pick<QueryCtx, 'db'>,
	mailbox: Doc<'mailboxes'>
): Promise<Set<string>> {
	const aliases = await ctx.db
		.query('mailAliases')
		.withIndex('by_target', (q) => q.eq('targetMailboxId', mailbox._id))
		.take(50);
	return new Set([mailbox.address, ...aliases.map((a) => a.alias)].map(normalizeEmail));
}

/** The thread's newest own and inbound messages among its last few. */
async function threadSides(
	ctx: Pick<QueryCtx, 'db'>,
	thread: Doc<'mailThreads'>,
	own: ReadonlySet<string>
): Promise<{ newest?: Doc<'mailMessages'>; ownMessage?: Doc<'mailMessages'>; inboundAt?: number }> {
	const newest = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', thread._id))
		.order('desc')
		.take(THREAD_MESSAGE_SCAN);
	const isOwn = (m: Doc<'mailMessages'>) =>
		m.outbound !== undefined || own.has(normalizeEmail(m.fromAddress));
	const ownMessage = newest.find(isOwn);
	const inbound = newest.find((m) => !isOwn(m) && !m.flagDraft);
	return {
		...(newest[0] ? { newest: newest[0] } : {}),
		...(ownMessage ? { ownMessage } : {}),
		...(inbound ? { inboundAt: inbound.receivedAt } : {}),
	};
}

/**
 * The mailbox's nudge rows: overdue items first (soonest due first), then
 * dateless ones, one per thread, skipping threads in `taken`. Bounded by
 * {@link NUDGE_SCAN_BUDGET} items read and {@link NUDGE_LIMIT} rows.
 */
export async function scanNudges(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	now: number,
	taken: ReadonlySet<string>
): Promise<NudgeQueueRow[]> {
	const mailbox = await ctx.db.get(mailboxId);
	if (!mailbox || !isPersonalMailbox(mailbox)) return [];
	const own = await ownAddressesOf(ctx, mailbox);
	const rows: NudgeQueueRow[] = [];
	const seen = new Set<string>(taken);
	let read = 0;
	for (const isDated of [true, false]) {
		for await (const item of openWaitingItems(ctx, mailboxId, now, isDated)) {
			if (++read > NUDGE_SCAN_BUDGET || rows.length >= NUDGE_LIMIT) return rows;
			const threadId = item.mailThreadId;
			if (!threadId || item.verify === 'proposal' || seen.has(threadId)) continue;
			// Cheap first: a dateless item younger than the wait cannot be stale.
			if (!isDated && addBusinessDays(item.askedAt, NUDGE_AFTER_BUSINESS_DAYS) > now) continue;
			seen.add(threadId);
			const thread = await ctx.db.get(threadId);
			if (!thread || thread.mailboxId !== mailboxId) continue;
			if (isThreadMuted(thread) || isFencedThread(thread)) continue;
			const sides = await threadSides(ctx, thread, own);
			const message = sides.ownMessage ?? sides.newest;
			if (!message || isMessageSnoozed(message, now)) continue;
			const verdict = nudgeVerdict({
				dueAt: item.due?.at,
				askedAt: item.askedAt,
				lastOwnAt: sides.ownMessage?.receivedAt,
				lastInboundAt: sides.inboundAt,
				now,
			});
			if (verdict) rows.push({ thread, item, message, reason: verdict.reason, since: verdict.at });
		}
	}
	return rows;
}

/** The nudge a "Remind me" follow-up card offers: none while the thread is fenced. */
export function reminderNudge(thread: Doc<'mailThreads'>): QueueNudge | undefined {
	return isFencedThread(thread) ? undefined : { reason: 'reminder' };
}

/** The nudge a stale item's card offers. */
export function itemNudge(row: NudgeQueueRow): QueueNudge {
	return {
		reason: row.reason,
		itemId: row.item._id,
		...(row.item.due?.at !== undefined ? { dueAt: row.item.due.at } : {}),
	};
}
