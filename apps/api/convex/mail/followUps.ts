/**
 * "Remind me if no reply" follow-up tracking on sent mail (Boomerang parity).
 *
 * A follow-up watch lives on the thread (`mailThreads.followUp`) and points at
 * the sent message being watched. It is armed either at send time (from the
 * draft's `followUpRemindAt`, see draftLifecycle's sent-effects) or after the
 * fact from the reader / sent list (`arm` below).
 *
 * Lifecycle:
 *   - ANY inbound delivery into the thread (except spam/trash-routed mail)
 *     clears the watch silently — the awaited reply arrived
 *     (delivery.deliverToMailbox calls clearThreadFollowUp).
 *   - Otherwise, at the deadline the 1-minute sweep cron (modeled on
 *     mail/snooze.ts internalSweep) resurfaces the thread EXACTLY once:
 *     the watched message is moved back into the Inbox, marked unread +
 *     flagged, the thread floats to the top (lastMessageAt bump), and
 *     `followUp.dueAt` is stamped — which also injects the thread into the
 *     Reply Queue as a "You're waiting on <name>" item (needsReply.listQueue).
 *   - `cancel` clears an armed or due watch from the UI chip.
 *
 * Deterministic v1 — no AI involved.
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { authedMutation } from '../lib/authedFunctions';
import type { Doc, Id } from '../_generated/dataModel';
import { throwForbidden, throwInvalidInput, throwNotFound } from '../_utils/errors';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { requireMailboxAccess, loadOwnedMessage } from './permissions';
import { adjustFolderUnseen } from './folders';
import { rebuildThreadAggregates } from './messageActions';

// ─── Pure helpers ────────────────────────────────────────────────────────────

/** "You're waiting on <name>" display hint — the first recipient. */
export function followUpWaitingOn(toAddresses: string[]): string | undefined {
	return toAddresses[0];
}

// ─── Helpers shared with sibling mail modules ────────────────────────────────

/** Arm (or re-arm) the follow-up watch on a thread. */
export async function armThreadFollowUp(
	ctx: MutationCtx,
	opts: {
		threadId: Id<'mailThreads'>;
		messageId: Id<'mailMessages'>;
		remindAt: number;
		waitingOn?: string;
	}
): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(opts.threadId, {
		followUp: {
			messageId: opts.messageId,
			remindAt: opts.remindAt,
			armedAt: now,
			waitingOn: opts.waitingOn,
		},
		followUpRemindAt: opts.remindAt,
		updatedAt: now,
	});
}

/**
 * Unset the follow-up watch (armed or due) on a thread. Called on any inbound
 * delivery into the thread (the awaited reply arrived — clears silently) and
 * by the manual cancel mutation.
 */
export async function clearThreadFollowUp(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	if (thread.followUp === undefined && thread.followUpRemindAt === undefined) return;
	await ctx.db.patch(threadId, {
		followUp: undefined,
		followUpRemindAt: undefined,
		updatedAt: Date.now(),
	});
}

// ─── Convex functions ────────────────────────────────────────────────────────

/**
 * Arm a follow-up on an already-sent message (reader / sent-list path — the
 * composer path stores `followUpRemindAt` on the draft instead and the
 * sent-effects reducer arms the watch at send time).
 */
// authz: message → mailbox ownership via loadOwnedMessage; org membership via
// authedMutation.
export const arm = authedMutation({
	args: {
		messageId: v.id('mailMessages'),
		remindAt: v.number(),
	},
	handler: async (ctx, args) => {
		const owned = await loadOwnedMessage(ctx, args.messageId);
		if (!owned.ok) throwForbidden('Message not accessible');
		if (args.remindAt <= Date.now()) {
			throwInvalidInput('Reminder time must be in the future');
		}
		const message = owned.message;
		// Only sent (owner-outbound) mail can wait on a reply.
		if (message.outbound === undefined) {
			const folder = await ctx.db.get(message.folderId);
			if (folder?.role !== 'sent') {
				throwInvalidInput('Follow-up reminders only apply to sent messages');
			}
		}
		await armThreadFollowUp(ctx, {
			threadId: message.threadId,
			messageId: message._id,
			remindAt: args.remindAt,
			waitingOn: followUpWaitingOn(message.toAddresses),
		});
	},
});

/** Cancel an armed (or dismiss a due) follow-up watch. */
// authz: thread → mailbox access via requireMailboxAccess; org membership via
// authedMutation.
export const cancel = authedMutation({
	args: { threadId: v.id('mailThreads') },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) throwNotFound('Thread');
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) throwForbidden('Thread not accessible');
		await clearThreadFollowUp(ctx, args.threadId);
	},
});

// ─── Internal cron sweep ─────────────────────────────────────────────────────

/**
 * Cron entry: resurface threads whose follow-up deadline passed with no reply.
 * Modeled on mail/snooze.ts internalSweep — `followUpRemindAt` is optional and
 * `undefined` sorts BEFORE every number on the index, so the range is
 * lower-bounded with gt(0) to skip the never-armed majority. Clearing
 * `followUpRemindAt` while stamping `followUp.dueAt` guarantees each watch
 * fires exactly once.
 */
export const internalSweep = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const dueRows = await ctx.db
			.query('mailThreads')
			.withIndex('by_follow_up_remind', (q) =>
				q.gt('followUpRemindAt', 0).lte('followUpRemindAt', now)
			)
			.take(100);
		const due = dueRows.filter(
			(t): t is Doc<'mailThreads'> & { followUp: NonNullable<Doc<'mailThreads'>['followUp']> } =>
				t.followUpRemindAt != null && t.followUp !== undefined
		);
		let resurfaced = 0;
		for (const thread of due) {
			const flag = thread.followUp;
			const message = await ctx.db.get(flag.messageId);
			if (!message) {
				// Watched message purged — drop the stale watch.
				await ctx.db.patch(thread._id, {
					followUp: undefined,
					followUpRemindAt: undefined,
					updatedAt: now,
				});
				continue;
			}

			// Move the watched sent message into the Inbox so the thread
			// resurfaces in the inbox view (Boomerang-style return-to-inbox).
			const inbox = await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) =>
					q.eq('mailboxId', thread.mailboxId).eq('role', 'inbox')
				)
				.first();
			if (inbox && message.folderId !== inbox._id) {
				const source = await ctx.db.get(message.folderId);
				if (source) {
					const countedUnread = !message.flagSeen && !isMessageSnoozed(message, now);
					await ctx.db.patch(source._id, {
						totalCount: Math.max(0, source.totalCount - 1),
						unseenCount: Math.max(0, source.unseenCount - (countedUnread ? 1 : 0)),
						highestModseq: source.highestModseq + 1,
						updatedAt: now,
					});
				}
				await ctx.db.patch(message._id, {
					folderId: inbox._id,
					uid: inbox.uidNext,
					modseq: inbox.highestModseq + 1,
					updatedAt: now,
				});
				await ctx.db.patch(inbox._id, {
					uidNext: inbox.uidNext + 1,
					highestModseq: inbox.highestModseq + 1,
					totalCount: inbox.totalCount + 1,
					// Unseen accounting for the unread-flip happens below via
					// adjustFolderUnseen (a sent message arrives here flagSeen).
					updatedAt: now,
				});
			}

			// Mark unread + flagged so the resurfaced row stands out.
			const fresh = await ctx.db.get(flag.messageId);
			if (fresh) {
				const patch: Partial<Doc<'mailMessages'>> = { updatedAt: now };
				if (!fresh.flagFlagged) patch.flagFlagged = true;
				if (fresh.flagSeen) {
					patch.flagSeen = false;
					// Snoozed messages are excluded from unseenCount (snooze.ts).
					if (!isMessageSnoozed(fresh, now)) {
						await adjustFolderUnseen(ctx, fresh.folderId, 1);
					}
				}
				await ctx.db.patch(fresh._id, patch);
			}

			// Re-derive thread aggregates (folderRoles/unreadCount/hasFlagged),
			// then float the thread to the top and stamp the due marker.
			await rebuildThreadAggregates(ctx, thread._id);
			const stillThere = await ctx.db.get(thread._id);
			if (!stillThere) continue;
			await ctx.db.patch(thread._id, {
				followUp: { ...flag, dueAt: now },
				followUpRemindAt: undefined,
				lastMessageAt: now,
				updatedAt: now,
			});
			resurfaced++;
		}
		return { resurfaced };
	},
});
