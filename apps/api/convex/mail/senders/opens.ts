/**
 * First opens (SPEC §5): the implementation behind the `recordFirstOpen` hook
 * and the two events that may call it.
 *
 *   - `markOpened({messageId})`: the reader showed this message open. Called
 *     by the Postbox reader once per opened message, whatever the mark-read
 *     policy is.
 *   - `brief.markSeen` on a mail thread (`recordThreadOpen`): the viewer saw
 *     the thread's Overview, which is about its newest inbound message.
 *
 * Never wired to bulk mark-read, `setFlags` or `markThreadRead`: marking
 * collapsed mail read is not reading it. `mailMessages.isOpenCounted` is the
 * guard: `false` was written when the delivery was counted (live mail in a
 * personal mailbox, `./delivery.ts`), so only that mail can count, and only
 * once.
 */

import { v } from 'convex/values';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { postboxMutation } from '../_helpers';
import { requireMailboxAccess } from '../permissions';
import { addSenderOpen } from './counters';
import {
	isPersonalMailboxId,
	loadSenderProfile,
	newestInboundMessage,
	senderKeyOf,
} from './profiles';

/** Count a message's first open in its sender's delivery-week bucket. */
export async function countFirstOpen(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<void> {
	const message = await ctx.db.get(messageId);
	if (!message || message.isOpenCounted !== false) return;
	// Counted while personal, opened after the mailbox became a team inbox:
	// a team's reading is not the person's.
	if (!(await isPersonalMailboxId(ctx, message.mailboxId))) return;
	const now = Date.now();
	await ctx.db.patch(message._id, { isOpenCounted: true });
	const profile = await loadSenderProfile(
		ctx,
		message.mailboxId,
		senderKeyOf(message.fromAddress).senderDigest
	);
	if (!profile) return;
	await ctx.db.patch(profile._id, {
		...addSenderOpen(profile, message._creationTime, now),
		updatedAt: now,
	});
}

/** `brief.markSeen` on a mail thread: its newest inbound message was seen. */
export async function countThreadOpen(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const mailbox = await ctx.db.get(thread.mailboxId);
	if (!mailbox) return;
	const inbound = await newestInboundMessage(ctx, thread, mailbox.address);
	if (inbound) await countFirstOpen(ctx, inbound._id);
}

/** The reader showed `messageId` open (see the module note). */
// authz: requireMailboxAccess on the message's mailbox.
export const markOpened = postboxMutation({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args, session) => {
		const message = await ctx.db.get(args.messageId);
		if (!message || message.isOpenCounted !== false) return null;
		const owned = await requireMailboxAccess(ctx, message.mailboxId, 'member', session);
		if (!owned.ok) return null;
		await countFirstOpen(ctx, message._id);
		return null;
	},
});
