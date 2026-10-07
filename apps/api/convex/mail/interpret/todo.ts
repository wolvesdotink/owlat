/**
 * The Workbench's "To do, no reply needed" band (plan §7 "Queues and the
 * Workbench"): mail that needs no answer but still owes something, such as an
 * invoice to pay or a domain to renew.
 *
 * Reads the mailbox's open for-you items (`us` and `unclear`) off
 * `by_mailbox_responsibility_due`: DATED items first, soonest due first, then
 * undated ones, each streamed in index order until enough eligible threads are
 * found. Unconfirmed proposals ("Check this"), threads the Answer queue
 * already shows (`needsReply` set) and muted threads are skipped while
 * streaming, so they cannot use up the read budget silently: when a stream
 * runs out of budget, or there are more threads than the band shows, the
 * result says so (`isTruncated`).
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { postboxQuery } from '../_helpers';
import { loadReadableMailbox } from '../permissions';
import { isThreadMuted } from '../../lib/mailMute';
import { openMessageBody } from '../../lib/messageBody';

/** Rows the band shows at most. */
export const TODO_BAND_LIMIT = 20;
/** Items one stream reads before it gives up and reports truncation. */
export const TODO_SCAN_BUDGET = 400;

type Item = Doc<'threadItems'>;
type Responsibility = 'us' | 'unclear';

/** Undated items sort after dated ones. */
function dueOrder(a: Item, b: Item): number {
	const at = a.due?.at ?? Number.POSITIVE_INFINITY;
	const bt = b.due?.at ?? Number.POSITIVE_INFINITY;
	return at - bt || a.askedAt - b.askedAt;
}

function stream(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	responsibility: Responsibility,
	isDated: boolean
): AsyncIterable<Item> {
	return ctx.db.query('threadItems').withIndex('by_mailbox_responsibility_due', (q) => {
		const open = q
			.eq('mailboxId', mailboxId)
			.eq('responsibility', responsibility)
			.eq('status', 'open');
		return isDated ? open.gte('due.at', 0) : open.eq('due.at', undefined);
	});
}

interface Candidate {
	thread: Doc<'mailThreads'>;
	first: Item;
}

/**
 * The first item of up to `want` eligible threads, in stream order, skipping
 * threads already in `taken`. `isTruncated` when the budget ran out first, or
 * when one more eligible thread exists past `want` (it reads one ahead).
 */
async function eligibleThreads(
	ctx: Pick<QueryCtx, 'db'>,
	items: AsyncIterable<Item>,
	want: number,
	taken: ReadonlySet<string>,
	threads: Map<string, Doc<'mailThreads'> | null>
): Promise<{ found: Candidate[]; isTruncated: boolean }> {
	const found: Candidate[] = [];
	const seen = new Set<string>();
	let read = 0;
	for await (const item of items) {
		if (++read > TODO_SCAN_BUDGET) return { found, isTruncated: true };
		const threadId = item.mailThreadId;
		if (item.verify === 'proposal' || !threadId || taken.has(threadId) || seen.has(threadId)) {
			continue;
		}
		if (!threads.has(threadId)) threads.set(threadId, await ctx.db.get(threadId));
		const thread = threads.get(threadId);
		if (!thread || thread.needsReply || isThreadMuted(thread)) continue;
		seen.add(threadId);
		found.push({ thread, first: item });
		if (found.length > want) return { found: found.slice(0, want), isTruncated: true };
	}
	return { found, isTruncated: false };
}

/**
 * Up to `limit` threads: dated ones first (merged across responsibilities by
 * due date), then undated ones. Exported for tests.
 */
export async function collectToDo(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	limit: number = TODO_BAND_LIMIT
): Promise<{ candidates: Candidate[]; isTruncated: boolean }> {
	const threads = new Map<string, Doc<'mailThreads'> | null>();
	const taken = new Set<string>();
	const candidates: Candidate[] = [];
	let isTruncated = false;
	for (const isDated of [true, false]) {
		const pass: Candidate[] = [];
		for (const responsibility of ['us', 'unclear'] as const) {
			const { found, isTruncated: cut } = await eligibleThreads(
				ctx,
				stream(ctx, mailboxId, responsibility, isDated),
				limit - candidates.length,
				taken,
				threads
			);
			isTruncated ||= cut;
			pass.push(...found);
		}
		// One thread may have items of both responsibilities: keep its earliest.
		pass.sort((a, b) => dueOrder(a.first, b.first));
		for (const candidate of pass) {
			if (taken.has(candidate.thread._id)) continue;
			if (candidates.length >= limit) {
				isTruncated = true;
				break;
			}
			taken.add(candidate.thread._id);
			candidates.push(candidate);
		}
	}
	return { candidates, isTruncated };
}

export const listNoReplyToDo = postboxQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return { rows: [], isTruncated: false };
		const { candidates, isTruncated } = await collectToDo(ctx, args.mailboxId);
		const rows = await Promise.all(
			candidates.map(async ({ thread, first }) => {
				const [en, de, latest] = await Promise.all([
					openMessageBody(first.display.en),
					openMessageBody(first.display.de),
					thread.latestMessageId ? ctx.db.get(thread.latestMessageId) : null,
				]);
				return {
					threadId: thread._id,
					messageId: thread.latestMessageId,
					itemId: first._id,
					text: { en, de },
					...(first.due?.at !== undefined ? { dueAt: first.due.at } : {}),
					// The thread's complete open count (mailThreads.briefTop), not the scan's.
					count: Math.max(1, thread.briefTop?.forYou ?? 1),
					...(thread.briefTop?.isCapped ? { isCountCapped: true } : {}),
					fromAddress: thread.latestFromAddress,
					...(latest?.fromName ? { fromName: latest.fromName } : {}),
					subject: thread.latestSubject,
					lastMessageAt: thread.lastMessageAt,
				};
			})
		);
		return { rows, isTruncated };
	},
});
