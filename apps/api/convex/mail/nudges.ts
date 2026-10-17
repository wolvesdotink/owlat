/**
 * Follow-up nudges (SPEC §7): a "Waiting on others" item that went stale
 * shows in the Answer queue as a follow-up card offering "Draft a nudge".
 *
 * Derived when the Answer queue list is read (`needsReply.listQueue`), from
 * what is already stored: the thread brief's open items the other side owes
 * (`threadItems`, responsibility `them`, read off
 * `by_mailbox_responsibility_due`) and the thread's newest messages. No cron
 * and no new rows. Because nothing is written when an item goes stale, a
 * card appears the next time the list query runs, not at the exact minute.
 * The always-mounted badge (`countQueue`) does not count nudge cards: it
 * would pay this scan on every rerun.
 *
 * **Budget.** One read inspects at most {@link NUDGE_ITEM_BUDGET} items and
 * {@link NUDGE_THREAD_BUDGET} threads (each: the thread and at most
 * {@link THREAD_MESSAGE_SCAN} messages), however many cards that yields.
 * When the budget runs out the scan stops and shows what it has.
 *
 * **Fail closed.** A thread whose newest message is theirs and newer than
 * the cut-off is cancelled from the thread row alone. Otherwise its newest
 * messages are read; when they do not reach back to the ask, a reply from
 * them may sit beyond them, so the item offers no nudge.
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
import { extractEmail } from '../lib/emailAddress';
import { isThreadMuted } from '../lib/mailMute';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { isPersonalMailbox } from './permissions';
import { isFencedThread } from './interpret/staleFence';

/** Business days a dateless waiting item waits before it asks for a nudge. */
export const NUDGE_AFTER_BUSINESS_DAYS = 3;
/** Waiting items one scan reads before it stops. */
export const NUDGE_ITEM_BUDGET = 100;
/** Threads one scan inspects (thread row plus its newest messages) before it stops. */
export const NUDGE_THREAD_BUDGET = 20;
/** Newest messages of a thread read for the reply check. */
export const THREAD_MESSAGE_SCAN = 10;

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

/** What the reply check knows about one thread, read once per scan. */
interface ThreadSignals {
	thread: Doc<'mailThreads'>;
	/** Its newest messages, newest first (at most {@link THREAD_MESSAGE_SCAN}). */
	newest: Doc<'mailMessages'>[];
	/** `newest` holds the whole thread. */
	isComplete: boolean;
}

function isOwnAddress(address: string, own: ReadonlySet<string>): boolean {
	return own.has(normalizeEmail(extractEmail(address)));
}

function isOwnMessage(m: Doc<'mailMessages'>, own: ReadonlySet<string>): boolean {
	return m.outbound !== undefined || isOwnAddress(m.fromAddress, own);
}

/**
 * The verdict for one item from its thread's signals, or null: also null
 * when the messages read cannot show there was no reply since the ask.
 */
function verdictFor(
	item: Doc<'threadItems'>,
	signals: ThreadSignals,
	own: ReadonlySet<string>,
	now: number
): { message: Doc<'mailMessages'>; reason: NudgeReason; since: number } | null {
	const { thread, newest, isComplete } = signals;
	const dueAt = item.due?.at;
	const cancelAfter = dueAt !== undefined ? Math.max(item.askedAt, dueAt) : item.askedAt;
	// Their message is the thread's newest: answered, from the row alone.
	const isLatestTheirs = !isOwnAddress(thread.latestFromAddress, own);
	if (isLatestTheirs && thread.lastMessageAt > cancelAfter) return null;
	const oldest = newest[newest.length - 1];
	if (!oldest || (!isComplete && oldest.receivedAt > item.askedAt)) return null; // fail closed
	const ownMessage = newest.find((m) => isOwnMessage(m, own));
	const inbound = newest.find((m) => !isOwnMessage(m, own) && !m.flagDraft);
	const verdict = nudgeVerdict({
		dueAt,
		askedAt: item.askedAt,
		lastOwnAt: ownMessage?.receivedAt,
		lastInboundAt: inbound?.receivedAt,
		now,
	});
	const message = ownMessage ?? newest[0]!;
	if (!verdict || isMessageSnoozed(message, now)) return null;
	return { message, reason: verdict.reason, since: verdict.at };
}

/**
 * The mailbox's nudge rows: overdue items first (soonest due first), then
 * dateless ones, one per thread, skipping threads in `taken`. Reads at most
 * {@link NUDGE_ITEM_BUDGET} items and inspects at most
 * {@link NUDGE_THREAD_BUDGET} threads (see the module header).
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
	const emitted = new Set<string>(taken);
	const signals = new Map<string, ThreadSignals | null>();
	let read = 0;
	for (const isDated of [true, false]) {
		for await (const item of openWaitingItems(ctx, mailboxId, now, isDated)) {
			if (++read > NUDGE_ITEM_BUDGET) return rows;
			const threadId = item.mailThreadId;
			if (!threadId || item.verify === 'proposal' || emitted.has(threadId)) continue;
			// Cheap first: a dateless item younger than the wait cannot be stale.
			if (!isDated && addBusinessDays(item.askedAt, NUDGE_AFTER_BUSINESS_DAYS) > now) continue;
			if (!signals.has(threadId)) {
				if (signals.size >= NUDGE_THREAD_BUDGET) return rows;
				signals.set(threadId, await loadSignals(ctx, threadId, mailboxId));
			}
			const known = signals.get(threadId);
			if (!known) continue;
			const verdict = verdictFor(item, known, own, now);
			if (!verdict) continue; // a later item of this thread may still qualify
			emitted.add(threadId);
			rows.push({ thread: known.thread, item, ...verdict });
		}
	}
	return rows;
}

/** A thread's signals, or null when it offers no nudge at all (gone, muted, fenced). */
async function loadSignals(
	ctx: Pick<QueryCtx, 'db'>,
	threadId: Id<'mailThreads'>,
	mailboxId: Id<'mailboxes'>
): Promise<ThreadSignals | null> {
	const thread = await ctx.db.get(threadId);
	if (!thread || thread.mailboxId !== mailboxId) return null;
	if (isThreadMuted(thread) || isFencedThread(thread)) return null;
	const newest = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', thread._id))
		.order('desc')
		.take(THREAD_MESSAGE_SCAN);
	return { thread, newest, isComplete: newest.length < THREAD_MESSAGE_SCAN };
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
