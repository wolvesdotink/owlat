/**
 * Message-level triage operations: flags, move, archive, delete, mark-read.
 *
 * Every mutation that changes a message bumps the containing folder's
 * `highestModseq` so IMAP CONDSTORE clients pick up the change. Folder
 * counters (`totalCount`, `unseenCount`) and thread aggregates are kept
 * in sync inline.
 */

import { v } from 'convex/values';
import { authedMutation } from '../lib/authedFunctions';
import type { Id, Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { requireMailboxAccess } from './permissions';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { adjustFolderUnseen, bumpFolderModseq } from './folders';
import { clearThreadNeedsReply } from './needsReply';
import { throwForbidden, throwInvalidState, throwNotFound } from '../_utils/errors';

type Flag = 'seen' | 'flagged' | 'answered' | 'deleted';

/**
 * Per-message provenance returned by the move-family mutations (move /
 * archive / trash / reportSpam / notSpam) so the client can offer an
 * "Undo" that moves each message back to the folder it came from.
 */
export type MovedMessage = {
	messageId: Id<'mailMessages'>;
	sourceFolderId: Id<'mailFolders'>;
};

type MoveResult = { ok: true; moved: MovedMessage[] };

/** Re-derive a thread's aggregate counters from its current messages. */
export async function rebuildThreadAggregates(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<void> {
	const thread = await ctx.db.get(threadId);
	if (!thread) return;
	const messages = await ctx.db
		.query('mailMessages')
		.withIndex('by_thread', (q) => q.eq('threadId', threadId))
		.collect(); // bounded: one thread's messages

	if (messages.length === 0) {
		await ctx.db.delete(threadId);
		return;
	}

	const sorted = [...messages].sort((a, b) => b.receivedAt - a.receivedAt);
	const latest = sorted[0]!;
	const oldest = sorted[sorted.length - 1]!;
	const unread = messages.filter((m) => !m.flagSeen).length;
	const hasFlagged = messages.some((m) => m.flagFlagged);
	const hasAttachments = messages.some((m) => m.hasAttachments);
	const folderRoles = new Set<string>();
	for (const m of messages) {
		const folder = await ctx.db.get(m.folderId);
		if (folder?.role) folderRoles.add(folder.role);
	}
	const labelIds = new Set<Id<'mailLabels'>>();
	for (const m of messages) {
		for (const l of m.labelIds) labelIds.add(l);
	}
	const participants = new Set<string>();
	for (const m of messages) {
		participants.add(m.fromAddress);
		for (const a of m.toAddresses) participants.add(a);
	}

	await ctx.db.patch(threadId, {
		messageCount: messages.length,
		unreadCount: unread,
		hasFlagged,
		hasAttachments,
		lastMessageAt: latest.receivedAt,
		firstMessageAt: oldest.receivedAt,
		latestSnippet: latest.snippet,
		latestFromAddress: latest.fromAddress,
		latestSubject: latest.subject,
		latestMessageId: latest._id,
		folderRoles: Array.from(folderRoles),
		labelIds: Array.from(labelIds),
		participants: Array.from(participants),
		updatedAt: Date.now(),
	});
}

/** Apply a flag delta to a single message and update folder/thread caches. */
async function applyFlagDelta(
	ctx: MutationCtx,
	message: Doc<'mailMessages'>,
	flagDeltas: Partial<Record<Flag, boolean>>
): Promise<void> {
	const folder = await ctx.db.get(message.folderId);
	if (!folder) return;

	const wasSeen = message.flagSeen;
	const patch: Partial<Doc<'mailMessages'>> = { updatedAt: Date.now() };

	if (flagDeltas.seen !== undefined) patch.flagSeen = flagDeltas.seen;
	if (flagDeltas.flagged !== undefined) patch.flagFlagged = flagDeltas.flagged;
	if (flagDeltas.answered !== undefined) patch.flagAnswered = flagDeltas.answered;
	if (flagDeltas.deleted !== undefined) patch.flagDeleted = flagDeltas.deleted;

	const modseq = await bumpFolderModseq(ctx, folder._id);
	patch.modseq = modseq;
	await ctx.db.patch(message._id, patch);

	// folder.unseenCount counts unread AND not-snoozed messages (snooze.ts
	// adjusts it when the snooze flag flips). A snoozed message isn't counted,
	// so a seen-flip on it must NOT touch the counter.
	const snoozed = isMessageSnoozed(message, Date.now());
	if (flagDeltas.seen !== undefined && flagDeltas.seen !== wasSeen && !snoozed) {
		await adjustFolderUnseen(ctx, folder._id, flagDeltas.seen ? -1 : +1);
	}
}

// ── Public mutations ──────────────────────────────────────────────

export const setFlags = authedMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		seen: v.optional(v.boolean()),
		flagged: v.optional(v.boolean()),
		answered: v.optional(v.boolean()),
	},
	handler: async (ctx, args) => {
		const flagDeltas: Partial<Record<Flag, boolean>> = {};
		if (args.seen !== undefined) flagDeltas.seen = args.seen;
		if (args.flagged !== undefined) flagDeltas.flagged = args.flagged;
		if (args.answered !== undefined) flagDeltas.answered = args.answered;
		if (Object.keys(flagDeltas).length === 0) return;

		const touchedThreads = new Set<Id<'mailThreads'>>();
		for (const id of args.messageIds) {
			const message = await ctx.db.get(id);
			if (!message) continue;
			const owned = await requireMailboxAccess(ctx, message.mailboxId);
			if (!owned.ok) continue;
			await applyFlagDelta(ctx, message, flagDeltas);
			touchedThreads.add(message.threadId);
		}
		for (const t of touchedThreads) {
			await rebuildThreadAggregates(ctx, t);
		}
	},
});

export const markThreadRead = authedMutation({
	args: { threadId: v.id('mailThreads'), seen: v.boolean() },
	handler: async (ctx, args) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return;
		const owned = await requireMailboxAccess(ctx, thread.mailboxId);
		if (!owned.ok) return;

		const messages = await ctx.db
			.query('mailMessages')
			.withIndex('by_thread', (q) => q.eq('threadId', args.threadId))
			.collect(); // bounded: one thread's messages
		for (const m of messages) {
			if (m.flagSeen === args.seen) continue;
			await applyFlagDelta(ctx, m, { seen: args.seen });
		}
		await rebuildThreadAggregates(ctx, args.threadId);
	},
});

/** Move messages to a destination folder. Allocates new UID per message. */
export const move = authedMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		targetFolderId: v.id('mailFolders'),
	},
	handler: async (ctx, args): Promise<MoveResult> => {
		const target = await ctx.db.get(args.targetFolderId);
		if (!target) throwNotFound('Target folder');
		const owned = await requireMailboxAccess(ctx, target.mailboxId);
		if (!owned.ok) throwForbidden('Folder not accessible');

		const now = Date.now();
		const moved: MovedMessage[] = [];
		const touchedThreads = new Set<Id<'mailThreads'>>();
		const sourceFolderTouches = new Map<Id<'mailFolders'>, { count: number; unread: number }>();

		// Cache the target folder counters in memory and write once at the end
		let targetUidNext = target.uidNext;
		let targetModseq = target.highestModseq + 1;
		let targetTotalDelta = 0;
		let targetUnseenDelta = 0;

		for (const id of args.messageIds) {
			const message = await ctx.db.get(id);
			if (!message) continue;
			if (message.folderId === args.targetFolderId) continue;
			if (message.mailboxId !== target.mailboxId) continue;

			const sourceFolder = await ctx.db.get(message.folderId);
			if (!sourceFolder) continue;

			// Snoozed messages aren't in either folder's unseenCount (see snooze.ts),
			// so a move must not shift the counter for them.
			const countsUnread = !message.flagSeen && !isMessageSnoozed(message, now);

			const sourceTouch = sourceFolderTouches.get(sourceFolder._id) ?? {
				count: 0,
				unread: 0,
			};
			sourceTouch.count += 1;
			if (countsUnread) sourceTouch.unread += 1;
			sourceFolderTouches.set(sourceFolder._id, sourceTouch);

			const uid = targetUidNext++;
			const modseq = targetModseq++;
			targetTotalDelta += 1;
			if (countsUnread) targetUnseenDelta += 1;

			await ctx.db.patch(id, {
				folderId: args.targetFolderId,
				uid,
				modseq,
				updatedAt: Date.now(),
			});
			moved.push({ messageId: id, sourceFolderId: sourceFolder._id });
			touchedThreads.add(message.threadId);
		}

		// Apply target folder deltas
		await ctx.db.patch(args.targetFolderId, {
			uidNext: targetUidNext,
			highestModseq: Math.max(target.highestModseq, targetModseq - 1),
			totalCount: target.totalCount + targetTotalDelta,
			unseenCount: target.unseenCount + targetUnseenDelta,
			updatedAt: Date.now(),
		});

		// Apply source folder deltas
		for (const [sourceId, touch] of sourceFolderTouches) {
			const source = await ctx.db.get(sourceId);
			if (!source) continue;
			await ctx.db.patch(sourceId, {
				totalCount: Math.max(0, source.totalCount - touch.count),
				unseenCount: Math.max(0, source.unseenCount - touch.unread),
				highestModseq: source.highestModseq + 1,
				updatedAt: Date.now(),
			});
		}

		// Archiving or trashing a thread's mail dismisses the Reply Queue signal
		// (the owner triaged it away without replying).
		const clearsNeedsReply = target.role === 'archive' || target.role === 'trash';
		for (const t of touchedThreads) {
			await rebuildThreadAggregates(ctx, t);
			if (clearsNeedsReply) await clearThreadNeedsReply(ctx, t);
		}
		return { ok: true, moved };
	},
});

/** Archive: move to the Archive system folder. */
// authz: access enforced by mail.messageActions.move (requireMailboxAccess per
// message); this is a thin folder-routing wrapper.
export const archive = authedMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args): Promise<MoveResult | undefined> => {
		const firstId = args.messageIds[0];
		if (!firstId) return undefined;
		const first = await ctx.db.get(firstId);
		if (!first) return undefined;
		const archive = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', first.mailboxId).eq('role', 'archive')
			)
			.first();
		if (!archive) throwInvalidState('Archive folder missing');
		return await ctx.runMutation((await import('../_generated/api')).api.mail.messageActions.move, {
			messageIds: args.messageIds,
			targetFolderId: archive._id,
		});
	},
});

/** Soft-delete: move to Trash. */
// authz: access enforced by mail.messageActions.move (requireMailboxAccess per
// message); this is a thin folder-routing wrapper.
export const trash = authedMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args): Promise<MoveResult | undefined> => {
		const firstId = args.messageIds[0];
		if (!firstId) return undefined;
		const first = await ctx.db.get(firstId);
		if (!first) return undefined;
		const trash = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', first.mailboxId).eq('role', 'trash')
			)
			.first();
		if (!trash) throwInvalidState('Trash folder missing');
		return await ctx.runMutation((await import('../_generated/api')).api.mail.messageActions.move, {
			messageIds: args.messageIds,
			targetFolderId: trash._id,
		});
	},
});

/** Permanently delete from storage (invoked manually from the Trash folder via
 * the bulk-actions bar's "Delete forever"). Frees the raw .eml blob too. */
export const purge = authedMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args): Promise<{ ok: true }> => {
		const touchedThreads = new Set<Id<'mailThreads'>>();
		for (const id of args.messageIds) {
			const message = await ctx.db.get(id);
			if (!message) continue;
			const owned = await requireMailboxAccess(ctx, message.mailboxId);
			if (!owned.ok) continue;

			const folder = await ctx.db.get(message.folderId);
			if (folder) {
				// A snoozed unread message isn't in unseenCount; don't decrement it.
				const wasCounted = !message.flagSeen && !isMessageSnoozed(message, Date.now());
				await ctx.db.patch(folder._id, {
					totalCount: Math.max(0, folder.totalCount - 1),
					unseenCount: Math.max(0, folder.unseenCount - (wasCounted ? 1 : 0)),
					highestModseq: folder.highestModseq + 1,
					updatedAt: Date.now(),
				});
			}

			const mailbox = await ctx.db.get(message.mailboxId);
			if (mailbox) {
				await ctx.db.patch(message.mailboxId, {
					usedBytes: Math.max(0, mailbox.usedBytes - message.rawSize),
					updatedAt: Date.now(),
				});
			}

			try {
				await ctx.storage.delete(message.rawStorageId);
			} catch {
				// Storage may already be gone — proceed to row deletion
			}
			if (message.textBodyStorageId) {
				try {
					await ctx.storage.delete(message.textBodyStorageId);
				} catch {
					/* noop */
				}
			}
			if (message.htmlBodyStorageId) {
				try {
					await ctx.storage.delete(message.htmlBodyStorageId);
				} catch {
					/* noop */
				}
			}

			touchedThreads.add(message.threadId);
			await ctx.db.delete(id);
		}
		for (const t of touchedThreads) {
			await rebuildThreadAggregates(ctx, t);
		}
		return { ok: true };
	},
});

/** Mark a single message read/unread (convenience wrapper). */
// authz: access enforced by mail.messageActions.setFlags (requireMailboxAccess).
export const markRead = authedMutation({
	args: { messageId: v.id('mailMessages'), seen: v.boolean() },
	handler: async (ctx, args): Promise<void> => {
		await ctx.runMutation((await import('../_generated/api')).api.mail.messageActions.setFlags, {
			messageIds: [args.messageId],
			seen: args.seen,
		});
	},
});

/** Star/unstar a single message. */
// authz: access enforced by mail.messageActions.setFlags (requireMailboxAccess).
export const setStar = authedMutation({
	args: { messageId: v.id('mailMessages'), starred: v.boolean() },
	handler: async (ctx, args): Promise<void> => {
		await ctx.runMutation((await import('../_generated/api')).api.mail.messageActions.setFlags, {
			messageIds: [args.messageId],
			flagged: args.starred,
		});
	},
});

/** Move messages to a system folder and stamp a spam verdict. */
async function moveToRoleWithVerdict(
	ctx: MutationCtx,
	messageIds: Id<'mailMessages'>[],
	role: 'spam' | 'inbox',
	verdict: 'spam' | 'ham'
): Promise<MoveResult> {
	const firstId = messageIds[0];
	if (!firstId) return { ok: true, moved: [] };
	const first = await ctx.db.get(firstId);
	if (!first) return { ok: true, moved: [] };
	const owned = await requireMailboxAccess(ctx, first.mailboxId);
	if (!owned.ok) throwForbidden('Messages not accessible');
	const folder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', first.mailboxId).eq('role', role))
		.first();
	if (!folder) throwInvalidState(`${role} folder missing`);
	for (const id of messageIds) {
		const m = await ctx.db.get(id);
		if (!m) continue;
		const o = await requireMailboxAccess(ctx, m.mailboxId);
		if (!o.ok) continue;
		await ctx.db.patch(id, { spamVerdict: verdict, updatedAt: Date.now() });
	}
	return await ctx.runMutation((await import('../_generated/api')).api.mail.messageActions.move, {
		messageIds,
		targetFolderId: folder._id,
	});
}

/** Report as spam: move to Spam and record the verdict. */
// authz: moveToRoleWithVerdict enforces ownership (requireMailboxAccess per message).
export const reportSpam = authedMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args): Promise<MoveResult> => {
		return await moveToRoleWithVerdict(ctx, args.messageIds, 'spam', 'spam');
	},
});

/** Not spam: rescue to the Inbox and clear the spam verdict. */
// authz: moveToRoleWithVerdict enforces ownership (requireMailboxAccess per message).
export const notSpam = authedMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args): Promise<MoveResult> => {
		return await moveToRoleWithVerdict(ctx, args.messageIds, 'inbox', 'ham');
	},
});

/**
 * Block a sender: create a high-priority filter that routes future mail from
 * this address to Spam (or deletes it if there's no Spam folder), and move the
 * current message to Spam.
 */
export const blockSender = authedMutation({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args): Promise<void> => {
		const message = await ctx.db.get(args.messageId);
		if (!message) return;
		const owned = await requireMailboxAccess(ctx, message.mailboxId);
		if (!owned.ok) throwForbidden('Message not accessible');

		const spam = await ctx.db
			.query('mailFolders')
			.withIndex('by_mailbox_and_role', (q) =>
				q.eq('mailboxId', message.mailboxId).eq('role', 'spam')
			)
			.first();
		const now = Date.now();
		await ctx.db.insert('mailFilters', {
			mailboxId: message.mailboxId,
			name: `Block ${message.fromAddress}`,
			isEnabled: true,
			priority: 0,
			conditions: [{ field: 'from', op: 'contains', value: message.fromAddress }],
			actions: spam ? [{ type: 'moveToFolder', folderId: spam._id }] : [{ type: 'delete' }],
			stopProcessing: true,
			createdAt: now,
			updatedAt: now,
		});
		if (spam) {
			await ctx.runMutation((await import('../_generated/api')).api.mail.messageActions.move, {
				messageIds: [args.messageId],
				targetFolderId: spam._id,
			});
		}
	},
});
