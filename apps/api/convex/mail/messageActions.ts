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
import { purgeMessageRow } from './messagePurge';
import { getOrThrow, throwForbidden, throwInvalidState } from '../_utils/errors';
import { rebuildThreadAggregates } from './threadAggregates';
import { recordTriageVerb } from './triageTally';

// Re-exported so the modules that reach the rebuild through this one keep
// working unchanged; it lives in ./threadAggregates now (size cap).
export { rebuildThreadAggregates };

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

/**
 * Move messages into a folder: new UID + modseq per row, both folders'
 * counters, thread aggregates, and the Reply-Queue dismissal on archive/trash.
 *
 * Exported and ctx-only so callers WITHOUT a session — the retroactive filter
 * sweep (`mail/filterRun.ts`), which runs as a scheduled internal mutation —
 * reuse this exact bookkeeping instead of a second, drifting copy. The caller
 * is responsible for authorization; the public `move` below does it.
 */
export async function moveMessagesToFolder(
	ctx: MutationCtx,
	args: { messageIds: Id<'mailMessages'>[]; targetFolderId: Id<'mailFolders'> }
): Promise<MoveResult> {
	const target = await getOrThrow(ctx, args.targetFolderId, 'Target folder');
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
			// Stamp entry into the bin and clear it on the way out, so the opt-in
			// auto-purge sweep can date a message by how long it has been TRASHED
			// rather than by when it arrived (idea 67).
			trashedAt: target.role === 'trash' ? now : undefined,
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
}

/** Move messages to a destination folder. Allocates new UID per message. */
export const move = authedMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		targetFolderId: v.id('mailFolders'),
	},
	handler: async (ctx, args): Promise<MoveResult> => {
		const target = await getOrThrow(ctx, args.targetFolderId, 'Target folder');
		const owned = await requireMailboxAccess(ctx, target.mailboxId);
		if (!owned.ok) throwForbidden('Folder not accessible');
		return moveMessagesToFolder(ctx, args);
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
		const result = await ctx.runMutation(
			(await import('../_generated/api')).api.mail.messageActions.move,
			{ messageIds: args.messageIds, targetFolderId: archive._id }
		);
		// Idea 27: one triage SESSION observed for these senders. Recorded on the
		// human-initiated wrapper only — the retroactive filter sweep also moves
		// mail through `move`, and a rule's own work must never become evidence
		// for suggesting that rule again.
		await recordTriageVerb(ctx, args.messageIds, 'archive');
		return result;
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
		const result = await ctx.runMutation(
			(await import('../_generated/api')).api.mail.messageActions.move,
			{ messageIds: args.messageIds, targetFolderId: trash._id }
		);
		await recordTriageVerb(ctx, args.messageIds, 'trash');
		return result;
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
			touchedThreads.add(await purgeMessageRow(ctx, message));
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
		const result = await moveToRoleWithVerdict(ctx, args.messageIds, 'spam', 'spam');
		await recordTriageVerb(ctx, args.messageIds, 'spam');
		return result;
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
