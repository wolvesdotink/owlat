/**
 * Pinned conversations: the few threads a mailbox keeps at the top of its
 * Inbox until someone unpins them.
 *
 * A pin is `mailThreads.pinnedAt`, a CONVERSATION fact like the mute marker,
 * so it is shared by everyone who reads the mailbox (a team inbox pins for the
 * team) and is independent of the star, which stays a per-message IMAP flag.
 * Nothing but `setPinned` here writes the field: new deliveries, the
 * aggregate rebuilds, archive and snooze all patch other fields of the thread,
 * so a pin survives them. Deleting the thread's last message deletes the
 * thread and its pin with it (`mail/threadAggregates.ts`).
 *
 * The band holds at most {@link PINNED_CONVERSATION_LIMIT} conversations. A
 * pin that would go past it is refused whole; nothing older is evicted to make
 * room, because a pin the user did not remove must not disappear. The count
 * and the writes happen in one mutation, and the count is an indexed read, so
 * two concurrent pins that would together overflow the band conflict and one
 * of them retries into the refusal.
 *
 * Message-keyed on purpose, like `mail/mute.ts`: the list rows, the reader and
 * the drag payload all hold message ids, so the server resolves the distinct
 * threads once instead of every caller doing it.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { postboxMutation, postboxQuery } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { batchGet } from '../_utils/batchLoader';
import { throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';

/** How many conversations one mailbox's band holds. */
export const PINNED_CONVERSATION_LIMIT = 5;

/**
 * Most message ids one pin or unpin accepts: a dragged page selection. Many
 * ids can still name a handful of threads; anything larger is not a gesture
 * the UI can make.
 */
const MAX_PIN_MESSAGE_IDS = 500;

/** One entry of the band: enough to render it and open the conversation. */
export type PinnedConversation = {
	threadId: Id<'mailThreads'>;
	/** The newest message, the one the band opens. */
	messageId: Id<'mailMessages'>;
	subject: string;
	fromAddress: string;
	fromName?: string;
	lastMessageAt: number;
	unreadCount: number;
	messageCount: number;
	pinnedAt: number;
};

/** The mailbox's pinned threads in pin order, oldest pin first. */
async function loadPinnedThreads(
	ctx: QueryCtx,
	mailboxId: Id<'mailboxes'>
): Promise<Doc<'mailThreads'>[]> {
	// An unpinned thread has no `pinnedAt` and sorts before every number, so
	// the lower bound skips them.
	return await ctx.db
		.query('mailThreads')
		.withIndex('by_mailbox_pinned', (q) => q.eq('mailboxId', mailboxId).gt('pinnedAt', 0))
		.take(PINNED_CONVERSATION_LIMIT);
}

/** The thread's newest message, for rows written before `latestMessageId`. */
async function newestMessageOf(
	ctx: QueryCtx,
	threadId: Id<'mailThreads'>
): Promise<Doc<'mailMessages'> | null> {
	return await ctx.db
		.query('mailMessages')
		.withIndex('by_thread_and_received', (q) => q.eq('threadId', threadId))
		.order('desc')
		.first();
}

// authz: requireMailboxAccess on the requested mailbox; org membership via the
// postboxQuery floor.
export const listPinned = postboxQuery({
	args: { mailboxId: v.id('mailboxes') },
	handler: async (
		ctx,
		args,
		session
	): Promise<{ conversations: PinnedConversation[]; limit: number }> => {
		const empty = { conversations: [], limit: PINNED_CONVERSATION_LIMIT };
		const owned = await requireMailboxAccess(ctx, args.mailboxId, 'member', session);
		if (!owned.ok) return empty;
		const threads = await loadPinnedThreads(ctx, args.mailboxId);
		const latest = await batchGet(
			ctx,
			threads.flatMap((thread) => (thread.latestMessageId ? [thread.latestMessageId] : []))
		);
		const conversations: PinnedConversation[] = [];
		for (const thread of threads) {
			const message =
				(thread.latestMessageId ? latest.get(thread.latestMessageId) : null) ??
				(await newestMessageOf(ctx, thread._id));
			// A thread with no message left is about to be deleted; nothing to open.
			if (!message || thread.pinnedAt === undefined) continue;
			conversations.push({
				threadId: thread._id,
				messageId: message._id,
				subject: thread.latestSubject,
				fromAddress: thread.latestFromAddress,
				...(message.fromName ? { fromName: message.fromName } : {}),
				lastMessageAt: thread.lastMessageAt,
				unreadCount: thread.unreadCount,
				messageCount: thread.messageCount,
				pinnedAt: thread.pinnedAt,
			});
		}
		return { conversations, limit: PINNED_CONVERSATION_LIMIT };
	},
});

/**
 * The distinct threads behind `messageIds`, all in one mailbox the caller can
 * read. A drop that mixes mailboxes is refused rather than half applied.
 */
async function resolveThreads(
	ctx: MutationCtx,
	messageIds: Id<'mailMessages'>[],
	session: Parameters<typeof requireMailboxAccess>[3]
): Promise<{ mailboxId: Id<'mailboxes'>; threads: Doc<'mailThreads'>[] }> {
	if (messageIds.length === 0) throwInvalidInput('No conversation to pin');
	if (messageIds.length > MAX_PIN_MESSAGE_IDS) {
		throwInvalidInput(`At most ${MAX_PIN_MESSAGE_IDS} messages at a time`);
	}
	const messages = await batchGet(ctx, messageIds);
	let mailboxId: Id<'mailboxes'> | null = null;
	const threadIds: Id<'mailThreads'>[] = [];
	for (const id of messageIds) {
		const message = messages.get(id);
		if (!message) throwForbidden('Message not accessible');
		if (mailboxId !== null && message.mailboxId !== mailboxId) {
			throwInvalidInput('Messages from different mailboxes cannot be pinned together');
		}
		mailboxId = message.mailboxId;
		threadIds.push(message.threadId);
	}
	if (mailboxId === null) throwInvalidInput('No conversation to pin');
	const owned = await requireMailboxAccess(ctx, mailboxId, 'member', session);
	if (!owned.ok) throwForbidden('Message not accessible');
	const loaded = await batchGet(ctx, threadIds);
	const threads: Doc<'mailThreads'>[] = [];
	for (const thread of loaded.values()) {
		if (thread) threads.push(thread);
	}
	return { mailboxId, threads };
}

/**
 * Pin or unpin the conversations of `messageIds`. Idempotent both ways: a
 * thread that is already in the asked state is left alone and keeps its
 * place. Pinning refuses with `invalid_state` when the band would hold more
 * than {@link PINNED_CONVERSATION_LIMIT}, and then writes nothing.
 */
// authz: message → mailbox access via requireMailboxAccess (one mailbox per
// call); org membership via the postboxMutation floor.
export const setPinned = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')), pinned: v.boolean() },
	handler: async (
		ctx,
		args,
		session
	): Promise<{ ok: true; threadIds: Id<'mailThreads'>[]; pinnedCount: number }> => {
		const { mailboxId, threads } = await resolveThreads(ctx, args.messageIds, session);
		const changing = threads.filter((thread) => (thread.pinnedAt !== undefined) !== args.pinned);
		const pinnedBefore = (await loadPinnedThreads(ctx, mailboxId)).length;
		const now = Date.now();
		if (args.pinned) {
			if (pinnedBefore + changing.length > PINNED_CONVERSATION_LIMIT) {
				throwInvalidState(
					`You can pin up to ${PINNED_CONVERSATION_LIMIT} conversations. Unpin one first.`,
					{ messageKey: 'postbox.pins.full', limit: PINNED_CONVERSATION_LIMIT }
				);
			}
			// One millisecond apart, so a multi-thread drop keeps its order in the band.
			for (const [index, thread] of changing.entries()) {
				await ctx.db.patch(thread._id, { pinnedAt: now + index, updatedAt: now });
			}
		} else {
			for (const thread of changing) {
				await ctx.db.patch(thread._id, { pinnedAt: undefined, updatedAt: now });
			}
		}
		return {
			ok: true,
			threadIds: threads.map((thread) => thread._id),
			pinnedCount: pinnedBefore + (args.pinned ? changing.length : -changing.length),
		};
	},
});
