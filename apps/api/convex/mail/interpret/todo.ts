/**
 * The Workbench's "To do, no reply needed" band (plan §7 "Queues and the
 * Workbench"): mail that needs no answer but still owes something, such as an
 * invoice to pay or a domain to renew.
 *
 * Reads open for-you items of one mailbox off `by_mailbox_responsibility_due`
 * (dated first, soonest first), keeps one row per thread, and drops threads
 * the Answer queue already shows (`needsReply` set) and muted ones. Unconfirmed
 * proposals ("Check this") are not tracked and never listed.
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
/** Items read per responsibility before grouping by thread. */
const ITEM_SCAN_LIMIT = 100;

type Item = Doc<'threadItems'>;

/** One thread per row, its first item in due order, and how many it has. Pure. */
export function groupToDoItems(
	items: readonly Item[]
): Array<{ threadId: Id<'mailThreads'>; first: Item; count: number }> {
	const byThread = new Map<string, { threadId: Id<'mailThreads'>; first: Item; count: number }>();
	for (const item of items) {
		const threadId = item.mailThreadId;
		if (item.verify === 'proposal' || !threadId) continue;
		const entry = byThread.get(threadId);
		if (entry) entry.count += 1;
		else byThread.set(threadId, { threadId, first: item, count: 1 });
	}
	return [...byThread.values()];
}

async function scan(
	ctx: Pick<QueryCtx, 'db'>,
	mailboxId: Id<'mailboxes'>,
	responsibility: 'us' | 'unclear'
): Promise<Item[]> {
	return ctx.db
		.query('threadItems')
		.withIndex('by_mailbox_responsibility_due', (q) =>
			q.eq('mailboxId', mailboxId).eq('responsibility', responsibility).eq('status', 'open')
		)
		.take(ITEM_SCAN_LIMIT);
}

/** Undated items sort after dated ones; the index orders undefined first. */
function dueOrder(a: Item, b: Item): number {
	const at = a.due?.at ?? Number.POSITIVE_INFINITY;
	const bt = b.due?.at ?? Number.POSITIVE_INFINITY;
	return at - bt || a.askedAt - b.askedAt;
}

export const listNoReplyToDo = postboxQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (ctx, args) => {
		const mailbox = await loadReadableMailbox(ctx, args.mailboxId);
		if (!mailbox) return [];
		const items = [
			...(await scan(ctx, args.mailboxId, 'us')),
			...(await scan(ctx, args.mailboxId, 'unclear')),
		].sort(dueOrder);
		const rows = [];
		for (const { threadId, first, count } of groupToDoItems(items)) {
			if (rows.length >= TODO_BAND_LIMIT) break;
			const thread = await ctx.db.get(threadId);
			if (!thread || thread.needsReply || isThreadMuted(thread)) continue;
			const [en, de, latest] = await Promise.all([
				openMessageBody(first.display.en),
				openMessageBody(first.display.de),
				thread.latestMessageId ? ctx.db.get(thread.latestMessageId) : null,
			]);
			rows.push({
				threadId: thread._id,
				messageId: thread.latestMessageId,
				itemId: first._id,
				text: { en, de },
				...(first.due?.at !== undefined ? { dueAt: first.due.at } : {}),
				count,
				fromAddress: thread.latestFromAddress,
				...(latest?.fromName ? { fromName: latest.fromName } : {}),
				subject: thread.latestSubject,
				lastMessageAt: thread.lastMessageAt,
			});
		}
		return rows;
	},
});
