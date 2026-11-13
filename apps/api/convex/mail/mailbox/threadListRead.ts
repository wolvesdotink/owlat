/**
 * The rows behind `listThreads`, the conversation list: one per thread with a
 * message in the folder, newest first, a thread whose newest message is
 * snoozed left out.
 *
 * The Inbox (the only folder the web app groups) reads
 * `by_mailbox_inbox_recency`, which holds exactly the mailbox's Inbox threads,
 * so a request reads the rows it returns, the one that says more exist, and
 * any snoozed threads among them. Every other folder, and the Inbox before
 * `inboxLastMessageAt` is backfilled, walks the mailbox's threads by recency
 * and drops the ones outside the folder.
 *
 * Both reads stop after `(limit + 1) * 3` threads, so a mailbox full of
 * snoozed or other-folder threads cannot make one request unbounded. A read
 * that stops there without filling the page reports `hasMore`: the threads
 * past it are unread, not absent, and the client's next, larger limit reaches
 * them.
 */

import type { Doc, Id } from '../../_generated/dataModel';
import type { QueryCtx } from '../../_generated/server';
import { isThreadLatestSnoozed } from '../threadLatestSnooze';
import { isInboxRecencyIndexReady } from '../threadInboxRecency';
import { toThreadListRow, type ThreadListRow } from './threadListRow';

/** Most rows one request returns, whatever the client asks for. */
const MAX_LIMIT = 500;

function threadsNewestFirst(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>,
	isInboxIndexed: boolean
): AsyncIterable<Doc<'mailThreads'>> {
	if (isInboxIndexed) {
		return ctx.db
			.query('mailThreads')
			.withIndex('by_mailbox_inbox_recency', (q) =>
				q.eq('mailboxId', mailboxId).gt('inboxLastMessageAt', 0)
			)
			.order('desc');
	}
	return ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_and_last_message', (q) => q.eq('mailboxId', mailboxId))
		.order('desc');
}

export async function readThreadList(
	ctx: QueryCtx,
	args: { mailboxId: Id<'mailboxes'>; folderRole: string; limit?: number }
): Promise<{ threads: ThreadListRow[]; hasMore: boolean }> {
	const now = Date.now();
	const limit = Math.min(args.limit ?? 50, MAX_LIMIT);
	const scanCap = (limit + 1) * 3;
	const isInboxIndexed = args.folderRole === 'inbox' && (await isInboxRecencyIndexReady(ctx));

	const threads: ThreadListRow[] = [];
	let scanned = 0;
	for await (const t of threadsNewestFirst(ctx, args.mailboxId, isInboxIndexed)) {
		scanned++;
		if (t.folderRoles.includes(args.folderRole) && !(await isThreadLatestSnoozed(ctx, t, now))) {
			threads.push(toThreadListRow(t));
			if (threads.length > limit) break;
		}
		if (scanned >= scanCap) break;
	}
	return {
		threads: threads.slice(0, limit),
		hasMore: threads.length > limit || scanned >= scanCap,
	};
}
