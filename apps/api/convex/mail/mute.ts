/**
 * Conversation mute — the "this thread is noisy, stop pulling me into it"
 * triage verb.
 *
 * A muted thread carries `mailThreads.mutedAt`. That single marker is read in
 * four places, so the verb is one write and no background work:
 *
 *   1. delivery (`mail/deliveryPipeline/insert.ts`) routes new inbound mail on
 *      the thread straight to Archive instead of the Inbox,
 *   2. desktop notifications never fire for it (`lib/desktop/notificationRules`),
 *   3. the Reply Queue skips it (`mail/needsReply.ts`), and
 *   4. the list row + reader header show a muted chip, so the state is legible
 *      rather than a mysterious silence.
 *
 * Muting a thread also archives the mail it ALREADY has in the Inbox — a mute
 * that only makes a promise about future deliveries leaves the current pile
 * sitting there, which is not what the verb reads as.
 *
 * Mute is a property of the CONVERSATION, not of the sender: muting one loud
 * thread never silences the same person elsewhere. Unmuting restores exactly
 * today's behaviour (the marker goes away); it deliberately does NOT un-archive
 * what the mute already filed, because that mail was genuinely triaged.
 *
 * Lives beside `mail/messageActions.ts` rather than inside it: that module sits
 * at the ~500 LOC file-size cap (CONVENTIONS.md → "Split only above ~500 LOC").
 */

import { v } from 'convex/values';
import { api } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { isThreadMuted } from '../lib/mailMute';
import { requireMailboxAccess } from './permissions';
import { clearThreadNeedsReply } from './needsReply';

/** The mailbox's Archive folder, or null when it hasn't been provisioned. */
async function findArchiveFolder(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>
): Promise<Doc<'mailFolders'> | null> {
	return await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', 'archive'))
		.first();
}

/**
 * Route a delivery into the muted thread's Archive instead of its Inbox.
 * Returns the folder the caller should actually insert into: the Archive when
 * the thread is muted and the target really was the Inbox, otherwise the
 * unchanged target. Fail-soft — a mailbox with no Archive folder keeps its
 * inbox delivery rather than losing the mail.
 */
export async function redirectMutedDelivery(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	folder: Doc<'mailFolders'>
): Promise<Doc<'mailFolders'>> {
	if (folder.role !== 'inbox') return folder;
	const thread = await ctx.db.get(threadId);
	if (!isThreadMuted(thread)) return folder;
	return (await findArchiveFolder(ctx, folder.mailboxId)) ?? folder;
}

/**
 * Mute + clear the inbox, shared by the thread- and message-addressed
 * mutations. Both entry points re-check mailbox access before calling in.
 *
 * The archive step reuses `mail.messageActions.move` (which owns UID/modseq
 * allocation and the folder counters) rather than re-deriving that arithmetic,
 * exactly like `messageActions.archive` does.
 */
async function applyMute(
	ctx: MutationCtx,
	thread: Doc<'mailThreads'>
): Promise<{ ok: true; archived: number }> {
	const now = Date.now();
	// Mute and the per-thread reply alert (mail/threadAlerts.ts) are the two ends
	// of one axis, so muting disarms the alert rather than leaving a thread that
	// is both silenced and shouting.
	await ctx.db.patch(thread._id, {
		mutedAt: now,
		...(thread.notifyOnReplyAt !== undefined ? { notifyOnReplyAt: undefined } : {}),
		updatedAt: now,
	});
	// A muted thread is one the owner opted out of; it has no business sitting
	// in the Reply Queue asking for an answer.
	await clearThreadNeedsReply(ctx, thread._id);

	const archive = await findArchiveFolder(ctx, thread.mailboxId);
	if (!archive) return { ok: true, archived: 0 };
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', thread._id))
		.collect(); // bounded: one thread's messages
	const inboxMessageIds: Id<'mailMessages'>[] = [];
	for (const m of messages) {
		if (m.folderId === archive._id) continue;
		const folder = await ctx.db.get(m.folderId);
		if (folder?.role === 'inbox') inboxMessageIds.push(m._id);
	}
	if (inboxMessageIds.length > 0) {
		await ctx.runMutation(api.mail.messageActions.move, {
			messageIds: inboxMessageIds,
			targetFolderId: archive._id,
		});
	}
	return { ok: true, archived: inboxMessageIds.length };
}

/** Drop the marker. No-op on a thread that was never muted. */
async function applyUnmute(ctx: MutationCtx, thread: Doc<'mailThreads'>): Promise<void> {
	if (thread.mutedAt == null) return;
	await ctx.db.patch(thread._id, { mutedAt: undefined, updatedAt: Date.now() });
}

/** Mute a conversation and archive what it already has in the Inbox. */
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const muteThread = authedMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args): Promise<{ ok: true; archived: number }> => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		return await applyMute(ctx, thread);
	},
});

/** Unmute a conversation: new mail lands in the Inbox again. */
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const unmuteThread = authedMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args): Promise<{ ok: true }> => {
		const thread = await getOrThrow(ctx, args.threadId, 'Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		await applyUnmute(ctx, thread);
		return { ok: true };
	},
});

/**
 * Mute/unmute keyed off the MESSAGE the UI has in hand — the list row and the
 * reader both address mail by message id, so making every caller resolve the
 * thread first would duplicate that lookup at each call site.
 */
// authz: message → thread → mailbox access via requireMailboxAccess; org
// membership via authedMutation.
export const setMutedForMessage = authedMutation({
	args: { messageId: v.id('mailMessages'), muted: v.boolean() },
	handler: async (ctx, args): Promise<{ ok: true; threadId: Id<'mailThreads'> }> => {
		const message = await getOrThrow(ctx, args.messageId, 'Message');
		const owned = await requireMailboxAccess(ctx, message.mailboxId);
		if (!owned.ok) throwForbidden('Message not accessible');
		const thread = await getOrThrow(ctx, message.threadId, 'Thread');
		if (args.muted) await applyMute(ctx, thread);
		else await applyUnmute(ctx, thread);
		return { ok: true, threadId: message.threadId };
	},
});
