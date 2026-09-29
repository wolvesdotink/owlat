/**
 * Message-level triage operations: flags, move, archive, delete, mark-read.
 *
 * Every mutation that changes a message bumps the containing folder's
 * `highestModseq` so IMAP CONDSTORE clients pick up the change. Folder
 * counters (`totalCount`, `unseenCount`) and thread aggregates are kept
 * in sync inline: flag changes apply deltas (`flagWrites.ts`), moves and
 * purges re-derive the thread (`threadAggregates.ts`).
 */

import { v } from 'convex/values';
import { postboxMutation } from './_helpers';
import type { Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { createMailboxAccessGate, requireMailboxAccess } from './permissions';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { clearThreadNeedsReply } from './needsReply';
import { purgeMessageRow } from './messagePurge';
import { getOrThrow, throwForbidden, throwInvalidState } from '../_utils/errors';
import {
	applyThreadFlagDeltas,
	rebuildThreadAggregates,
	type ThreadFlagDeltas,
} from './threadAggregates';
import {
	FolderFlagWrites,
	markThreadSeenBatch,
	newestThreadMessageCreation,
	writeMessageFlags,
	type Flag,
} from './flagWrites';
import { recordTriageVerb } from './triageTally';
import { recordMessageCounters } from './messageCounters';

// Re-exported so the modules that reach the rebuild through this one keep
// working unchanged; it lives in ./threadAggregates now (size cap).
export { rebuildThreadAggregates };

/**
 * Per-message provenance returned by the move-family mutations (move /
 * archive / trash / reportSpam / notSpam) so the client can offer an
 * "Undo" that moves each message back to the folder it came from.
 */
type MovedMessage = {
	messageId: Id<'mailMessages'>;
	sourceFolderId: Id<'mailFolders'>;
};

type MoveResult = { ok: true; moved: MovedMessage[] };

/** One handler's memoized mailbox gate (see `createMailboxAccessGate`). */
type AccessGate = ReturnType<typeof createMailboxAccessGate>;

/**
 * Apply a flag delta to every message the caller can access, then apply the
 * touched threads' `unreadCount` / `hasFlagged` deltas (plan 3.3: a star or a
 * mark-read no longer re-reads the whole thread). Shared by `setFlags` and its
 * single-message wrappers, which call it directly: they used to go through
 * `ctx.runMutation` with `api` loaded by a dynamic `import()`, and the Convex
 * isolate rejects that at call time ("dynamic module import unsupported").
 */
async function applyFlags(
	ctx: MutationCtx,
	session: MutationSessionContext,
	messageIds: Id<'mailMessages'>[],
	flagDeltas: Partial<Record<Flag, boolean>>
): Promise<void> {
	if (Object.keys(flagDeltas).length === 0) return;
	// One access decision per mailbox, not per message (plan 1.13).
	const access = createMailboxAccessGate(ctx, session);
	const folders = new FolderFlagWrites(ctx);
	const threads: ThreadFlagDeltas = new Map();
	for (const id of messageIds) {
		const message = await ctx.db.get(id);
		if (!message) continue;
		const owned = await access(message.mailboxId);
		if (!owned.ok) continue;
		await writeMessageFlags(ctx, folders, threads, message, flagDeltas);
	}
	await folders.flush();
	await applyThreadFlagDeltas(ctx, threads);
}

// ── Public mutations ──────────────────────────────────────────────

// authz: access enforced by applyFlags (the mailbox gate per message, decided
// once per mailbox by createMailboxAccessGate).
export const setFlags = postboxMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		seen: v.optional(v.boolean()),
		flagged: v.optional(v.boolean()),
		answered: v.optional(v.boolean()),
	},
	handler: async (ctx, args, session) => {
		const flagDeltas: Partial<Record<Flag, boolean>> = {};
		if (args.seen !== undefined) flagDeltas.seen = args.seen;
		if (args.flagged !== undefined) flagDeltas.flagged = args.flagged;
		if (args.answered !== undefined) flagDeltas.answered = args.answered;
		await applyFlags(ctx, session, args.messageIds, flagDeltas);
	},
});

export const markThreadRead = postboxMutation({
	args: { threadId: v.id('mailThreads'), seen: v.boolean() },
	handler: async (ctx, args, session) => {
		const thread = await ctx.db.get(args.threadId);
		if (!thread) return;
		const owned = await requireMailboxAccess(ctx, thread.mailboxId, 'member', session);
		if (!owned.ok) return;
		const { more } = await markThreadSeenBatch(ctx, args.threadId, args.seen);
		if (more) {
			// Mail that arrives while a long thread is still being flipped is not
			// part of what the user marked.
			await ctx.scheduler.runAfter(0, internal.mail.messageActions.continueMarkThreadRead, {
				...args,
				ceiling: await newestThreadMessageCreation(ctx, args.threadId),
			});
		}
	},
});

/**
 * The rest of a mark-thread-read too large for one transaction. Scheduled only
 * by `markThreadRead` above, after its mailbox-access check passed.
 */
export const continueMarkThreadRead = internalMutation({
	args: { threadId: v.id('mailThreads'), seen: v.boolean(), ceiling: v.number() },
	handler: async (ctx, args) => {
		const { more } = await markThreadSeenBatch(ctx, args.threadId, args.seen, args.ceiling);
		if (more) {
			await ctx.scheduler.runAfter(0, internal.mail.messageActions.continueMarkThreadRead, args);
		}
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
		await recordMessageCounters(ctx, message, { ...message, folderId: args.targetFolderId });
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

/**
 * `moveMessagesToFolder` behind the caller's mailbox-access check: the body of
 * the public `move`, and what the folder-routing wrappers below call directly.
 * Takes the handler's access gate so a wrapper that already checked the same
 * mailbox does not pay for the check twice.
 */
async function moveWithAccess(
	ctx: MutationCtx,
	access: AccessGate,
	args: { messageIds: Id<'mailMessages'>[]; targetFolderId: Id<'mailFolders'> }
): Promise<MoveResult> {
	const target = await getOrThrow(ctx, args.targetFolderId, 'Target folder');
	const owned = await access(target.mailboxId);
	if (!owned.ok) throwForbidden('Folder not accessible');
	return moveMessagesToFolder(ctx, args);
}

/** Move messages to a destination folder. Allocates new UID per message. */
// authz: access enforced by moveWithAccess (requireMailboxAccess on the target
// folder's mailbox).
export const move = postboxMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		targetFolderId: v.id('mailFolders'),
	},
	handler: async (ctx, args, session): Promise<MoveResult> =>
		moveWithAccess(ctx, createMailboxAccessGate(ctx, session), args),
});

/** Archive: move to the Archive system folder. */
// authz: access enforced by moveWithAccess (requireMailboxAccess on the target
// folder's mailbox); this is a thin folder-routing wrapper.
export const archive = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args, session): Promise<MoveResult | undefined> => {
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
		const result = await moveWithAccess(ctx, createMailboxAccessGate(ctx, session), {
			messageIds: args.messageIds,
			targetFolderId: archive._id,
		});
		// Idea 27: one triage SESSION observed for these senders. Recorded on the
		// human-initiated wrapper only — the retroactive filter sweep also moves
		// mail through `move`, and a rule's own work must never become evidence
		// for suggesting that rule again.
		await recordTriageVerb(ctx, args.messageIds, 'archive');
		return result;
	},
});

/** Soft-delete: move to Trash. */
// authz: access enforced by moveWithAccess (requireMailboxAccess on the target
// folder's mailbox); this is a thin folder-routing wrapper.
export const trash = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args, session): Promise<MoveResult | undefined> => {
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
		const result = await moveWithAccess(ctx, createMailboxAccessGate(ctx, session), {
			messageIds: args.messageIds,
			targetFolderId: trash._id,
		});
		await recordTriageVerb(ctx, args.messageIds, 'trash');
		return result;
	},
});

/** Permanently delete from storage (invoked manually from the Trash folder via
 * the bulk-actions bar's "Delete forever"). Frees the raw .eml blob too. */
// authz: the mailbox gate per message (createMailboxAccessGate, decided once per
// mailbox); messages in a mailbox the caller cannot access are skipped.
export const purge = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args, session): Promise<{ ok: true }> => {
		const access = createMailboxAccessGate(ctx, session);
		const touchedThreads = new Set<Id<'mailThreads'>>();
		for (const id of args.messageIds) {
			const message = await ctx.db.get(id);
			if (!message) continue;
			const owned = await access(message.mailboxId);
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
// authz: access enforced by applyFlags (the mailbox gate per message, decided
// once per mailbox by createMailboxAccessGate).
export const markRead = postboxMutation({
	args: { messageId: v.id('mailMessages'), seen: v.boolean() },
	handler: async (ctx, args, session): Promise<void> => {
		await applyFlags(ctx, session, [args.messageId], { seen: args.seen });
	},
});

/** Star/unstar a single message. */
// authz: access enforced by applyFlags (the mailbox gate per message, decided
// once per mailbox by createMailboxAccessGate).
export const setStar = postboxMutation({
	args: { messageId: v.id('mailMessages'), starred: v.boolean() },
	handler: async (ctx, args, session): Promise<void> => {
		await applyFlags(ctx, session, [args.messageId], { flagged: args.starred });
	},
});

/** Move messages to a system folder and stamp a spam verdict. */
async function moveToRoleWithVerdict(
	ctx: MutationCtx,
	session: MutationSessionContext,
	messageIds: Id<'mailMessages'>[],
	role: 'spam' | 'inbox',
	verdict: 'spam' | 'ham'
): Promise<MoveResult> {
	const firstId = messageIds[0];
	if (!firstId) return { ok: true, moved: [] };
	const first = await ctx.db.get(firstId);
	if (!first) return { ok: true, moved: [] };
	// One decision per mailbox across the first-message check, the per-message
	// loop and the move's target check (plan 1.13).
	const access = createMailboxAccessGate(ctx, session);
	const owned = await access(first.mailboxId);
	if (!owned.ok) throwForbidden('Messages not accessible');
	const folder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', first.mailboxId).eq('role', role))
		.first();
	if (!folder) throwInvalidState(`${role} folder missing`);
	for (const id of messageIds) {
		const m = await ctx.db.get(id);
		if (!m) continue;
		const o = await access(m.mailboxId);
		if (!o.ok) continue;
		await ctx.db.patch(id, { spamVerdict: verdict, updatedAt: Date.now() });
	}
	return await moveWithAccess(ctx, access, { messageIds, targetFolderId: folder._id });
}

/** Report as spam: move to Spam and record the verdict. */
// authz: moveToRoleWithVerdict enforces ownership (the mailbox gate per message,
// decided once per mailbox by createMailboxAccessGate).
export const reportSpam = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args, session): Promise<MoveResult> => {
		const result = await moveToRoleWithVerdict(ctx, session, args.messageIds, 'spam', 'spam');
		await recordTriageVerb(ctx, args.messageIds, 'spam');
		return result;
	},
});

/** Not spam: rescue to the Inbox and clear the spam verdict. */
// authz: moveToRoleWithVerdict enforces ownership (the mailbox gate per message,
// decided once per mailbox by createMailboxAccessGate).
export const notSpam = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args, session): Promise<MoveResult> => {
		return await moveToRoleWithVerdict(ctx, session, args.messageIds, 'inbox', 'ham');
	},
});

/**
 * Block a sender: create a high-priority filter that routes future mail from
 * this address to Spam (or deletes it if there's no Spam folder), and move the
 * current message to Spam.
 */
// authz: the mailbox gate on the message's mailbox (createMailboxAccessGate), shared
// with the move to Spam.
export const blockSender = postboxMutation({
	args: { messageId: v.id('mailMessages') },
	handler: async (ctx, args, session): Promise<void> => {
		const message = await ctx.db.get(args.messageId);
		if (!message) return;
		const access = createMailboxAccessGate(ctx, session);
		const owned = await access(message.mailboxId);
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
			await moveWithAccess(ctx, access, { messageIds: [args.messageId], targetFolderId: spam._id });
		}
	},
});
