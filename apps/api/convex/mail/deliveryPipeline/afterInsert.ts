/**
 * Personal-mail delivery pipeline — what an inbound insert sets off.
 *
 * Hosted MX delivery (`mail/delivery.ts::deliverToMailbox`) and external IMAP
 * sync (`mail/external/delivery.ts::ingestExternalMessage`) both land inbound
 * mail through `insertDeliveredMessage` and then have to tell the rest of the
 * mailbox about it. That tail used to be written out at each site and drifted:
 * synced replies never cleared "remind me if no reply" or "snooze until they
 * reply", and MX delivery never settled the Reply Queue on an owner reply. It
 * lives here once.
 *
 * Not called by IMAP APPEND (`mail/imap/append.ts`), which is a client filing a
 * copy rather than mail arriving, or by archive import, which is history.
 */

import type { MutationCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { clearNeedsReplyOnOwnerReply, enqueueNeedsReplyCheck } from '../needsReply';
import { isFromMailboxOwner } from '../needsReplyHeuristic';
import { enqueueCategoryCheck } from '../category';
import { clearThreadFollowUp } from '../followUps';
import { clearSnoozeUntilReplyForThread } from '../snooze';

/**
 * Where an inbound message came from. `'mx'` is hosted delivery, `'sync'` is
 * forward IMAP sync, `'backfill'` is a historical IMAP import (and what an
 * older sync worker that sends no origin is read as).
 */
export type InboundOrigin = 'mx' | 'sync' | 'backfill';

/** Folders whose mail is never "the reply arrived". */
const NOT_A_REPLY_ROLES: ReadonlySet<string> = new Set(['spam', 'trash', 'sent', 'drafts']);

/**
 * Run the side effects of one inbound insert.
 *
 * `folder` is the folder the caller chose. The row's ACTUAL folder can differ:
 * a muted thread's delivery is re-routed to Archive inside the insert
 * (mail/mute.ts), and the classifiers should not spend work on it.
 *
 *   - Reply Queue + smart-inbox category enqueues: inbox mail that stayed in
 *     the inbox, never from a backfill (importing years of history must not
 *     fan out background LLM work). The anti-loop headers ride along because
 *     they are not persisted on the row.
 *   - Follow-up and snooze-until-reply clears: the awaited reply arrived. Only
 *     for mail from someone other than the mailbox owner, outside Spam, Trash,
 *     Sent and Drafts, and never from a backfill (an old message is not a new
 *     reply).
 *   - The owner's own reply settles the thread's Reply Queue row.
 */
export async function runPostInsertInboundEffects(
	ctx: MutationCtx,
	params: {
		messageId: Id<'mailMessages'>;
		folder: Doc<'mailFolders'>;
		origin: InboundOrigin;
		antiLoopHeaders?: Record<string, string>;
	}
): Promise<void> {
	const { messageId, folder, origin, antiLoopHeaders } = params;
	const delivered = await ctx.db.get(messageId);
	if (!delivered) return;
	const isLive = origin !== 'backfill';

	if (isLive && folder.role === 'inbox' && delivered.folderId === folder._id) {
		const precedence = antiLoopHeaders?.['precedence'];
		await enqueueNeedsReplyCheck(ctx, delivered.threadId, {
			precedence,
			// RFC 3834 / list traffic: the strongest "a machine sent this" signal
			// the Reply Queue can get, and like Precedence it lives only on the
			// wire.
			autoSubmitted: antiLoopHeaders?.['auto-submitted'],
			listId: antiLoopHeaders?.['list-id'],
		});
		await enqueueCategoryCheck(ctx, delivered.threadId, { precedence });
	}

	if (isLive && !(folder.role !== undefined && NOT_A_REPLY_ROLES.has(folder.role))) {
		const mailbox = await ctx.db.get(delivered.mailboxId);
		if (mailbox && !isFromMailboxOwner(delivered, mailbox.address)) {
			await clearThreadFollowUp(ctx, delivered.threadId);
			await clearSnoozeUntilReplyForThread(ctx, delivered.threadId, Date.now());
		}
	}

	await clearNeedsReplyOnOwnerReply(ctx, messageId);
}
