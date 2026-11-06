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
import type { MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { createMailboxAccessGate, requireMailboxAccess } from './permissions';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import { isMessageSnoozed } from '../lib/mailSnooze';
import { clearThreadNeedsReply } from './needsReply';
import { purgeMessageRow, purgeThreadBriefsOf, type PurgedMessages } from './messagePurge';
import { getOrThrow, throwForbidden } from '../_utils/errors';
import { roleFolderGroups, type RoleFolderGroup } from './roleFolderGroups';
import {
	applyThreadFlagDeltas,
	applyThreadFolderMove,
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
import { recordFolderMembership } from './folderMembership';
import { recordRemoteChanges, type RemoteChange } from './external/remoteOps';
import { recordArchivedMoves } from './interpret/threadEvents';
import { recordUnreadArchives, unreadArchiveCandidates } from './arrival/learningSignals';

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
	const remote: RemoteChange[] = [];
	for (const id of messageIds) {
		const message = await ctx.db.get(id);
		if (!message) continue;
		const owned = await access(message.mailboxId);
		if (!owned.ok) continue;
		const change = await writeMessageFlags(ctx, folders, threads, message, flagDeltas);
		if (change) remote.push(change);
	}
	await folders.flush();
	await applyThreadFlagDeltas(ctx, threads);
	await recordRemoteChanges(ctx, remote);
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
		const { more } = await markThreadSeenBatch(ctx, thread._id, args.seen, { reader: owned });
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
		const { more } = await markThreadSeenBatch(ctx, args.threadId, args.seen, args);
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
	args: { messageIds: Id<'mailMessages'>[]; targetFolderId: Id<'mailFolders'> },
	// writeBack false: mirrors a provider's own move (external/remoteState.ts).
	// isNeedsReplyKept: keep the thread's Reply Queue state (it still has Inbox mail).
	// isFolderRolesOnly: bounded thread update, no whole-thread re-read (replyDone.ts).
	options: { writeBack?: boolean; isNeedsReplyKept?: boolean; isFolderRolesOnly?: boolean } = {}
): Promise<MoveResult> {
	const target = await getOrThrow(ctx, args.targetFolderId, 'Target folder');
	const now = Date.now();
	const moved: MovedMessage[] = [];
	const remote: RemoteChange[] = [];
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
		await recordFolderMembership(ctx, message, { ...message, folderId: args.targetFolderId, uid });
		moved.push({ messageId: id, sourceFolderId: sourceFolder._id });
		remote.push({
			kind: 'move',
			message,
			sourceFolderId: sourceFolder._id,
			targetFolderId: args.targetFolderId,
		});
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
	const clearsNeedsReply =
		(target.role === 'archive' || target.role === 'trash') && !options.isNeedsReplyKept;
	for (const t of touchedThreads) {
		if (!options.isFolderRolesOnly) await rebuildThreadAggregates(ctx, t);
		else
			await applyThreadFolderMove(ctx, t, { sourceFolderIds: sourceFolderTouches.keys(), target });
		if (clearsNeedsReply) await clearThreadNeedsReply(ctx, t);
	}
	if (options.writeBack !== false) await recordRemoteChanges(ctx, remote);
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
		// A server caller's side-effect archive (mute, unsubscribe): never evidence (§4.3).
		isAutomatic: v.optional(v.boolean()),
	},
	handler: async (ctx, args, session): Promise<MoveResult> => {
		const { isAutomatic, ...move } = args;
		const unread = isAutomatic
			? null
			: await unreadArchiveCandidates(ctx, move.messageIds, move.targetFolderId);
		const result = await moveWithAccess(ctx, createMailboxAccessGate(ctx, session), move);
		await recordUnreadArchives(ctx, unread, result.moved, { now: Date.now() });
		return result;
	},
});

/**
 * The selection's groups (see `roleFolderGroups`) each moved to their own
 * mailbox's folder, behind the handler's access gate.
 */
async function moveGroups(
	ctx: MutationCtx,
	access: AccessGate,
	groups: RoleFolderGroup[]
): Promise<MoveResult> {
	const moved: MovedMessage[] = [];
	for (const group of groups) {
		const result = await moveWithAccess(ctx, access, {
			messageIds: group.messageIds,
			targetFolderId: group.folderId,
		});
		moved.push(...result.moved);
	}
	return { ok: true, moved };
}

/** Archive: move to the Archive system folder of each message's mailbox. */
// authz: access enforced by roleFolderGroups and moveWithAccess
// (requireMailboxAccess on each target folder's mailbox).
export const archive = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args, session): Promise<MoveResult | undefined> => {
		const access = createMailboxAccessGate(ctx, session);
		const groups = await roleFolderGroups(ctx, access, args.messageIds, 'archive');
		if (groups.length === 0) return undefined;
		// Read on arrival §4.3: which messages were unread live mail, read BEFORE the move.
		const unread: Awaited<ReturnType<typeof unreadArchiveCandidates>>[] = [];
		for (const group of groups) {
			unread.push(await unreadArchiveCandidates(ctx, group.messageIds, group.folderId));
		}
		const result = await moveGroups(ctx, access, groups);
		const reached = groups.flatMap((group) => group.messageIds);
		// Idea 27: one triage SESSION observed for these senders. Recorded on the
		// human-initiated wrapper only — the retroactive filter sweep also moves
		// mail through `move`, and a rule's own work must never become evidence
		// for suggesting that rule again.
		await recordTriageVerb(ctx, reached, 'archive');
		const now = Date.now();
		for (const candidates of unread) {
			await recordUnreadArchives(ctx, candidates, result.moved, { now });
		}
		await recordArchivedMoves(ctx, result.moved, session.userId);
		return result;
	},
});

/** Soft-delete: move to the Trash of each message's mailbox. */
// authz: access enforced by roleFolderGroups and moveWithAccess
// (requireMailboxAccess on each target folder's mailbox).
export const trash = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')) },
	handler: async (ctx, args, session): Promise<MoveResult | undefined> => {
		const access = createMailboxAccessGate(ctx, session);
		const groups = await roleFolderGroups(ctx, access, args.messageIds, 'trash');
		if (groups.length === 0) return undefined;
		const result = await moveGroups(ctx, access, groups);
		await recordTriageVerb(
			ctx,
			groups.flatMap((group) => group.messageIds),
			'trash'
		);
		return result;
	},
});

/** Permanently delete from storage (the bulk bars' "Delete forever" in Trash). Frees
 * the raw .eml blob too, and on an external mailbox deletes the provider's copy.
 * `onlyFromTrash` skips what is not filed in Trash, so a stale selection cannot
 * destroy it; it is opt-in because undoing a cross-mailbox copy purges anywhere. */
// authz: the mailbox gate per message (createMailboxAccessGate, decided once per
// mailbox); messages in a mailbox the caller cannot access are skipped.
export const purge = postboxMutation({
	args: { messageIds: v.array(v.id('mailMessages')), onlyFromTrash: v.optional(v.boolean()) },
	handler: async (ctx, args, session): Promise<{ ok: true }> => {
		const access = createMailboxAccessGate(ctx, session);
		const touchedThreads = new Set<Id<'mailThreads'>>();
		const purged: PurgedMessages = new Map();
		const remote: RemoteChange[] = [];
		for (const id of args.messageIds) {
			const message = await ctx.db.get(id);
			if (!message) continue;
			const owned = await access(message.mailboxId);
			if (!owned.ok) continue;
			if (args.onlyFromTrash && (await ctx.db.get(message.folderId))?.role !== 'trash') continue;
			touchedThreads.add(await purgeMessageRow(ctx, message, purged));
			remote.push({ kind: 'delete', message });
		}
		await purgeThreadBriefsOf(ctx, purged);
		for (const t of touchedThreads) {
			await rebuildThreadAggregates(ctx, t);
		}
		await recordRemoteChanges(ctx, remote);
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

/**
 * Move messages to a system folder of their own mailbox and stamp a spam
 * verdict on the ones the caller can reach.
 */
async function moveToRoleWithVerdict(
	ctx: MutationCtx,
	session: MutationSessionContext,
	messageIds: Id<'mailMessages'>[],
	role: 'spam' | 'inbox',
	verdict: 'spam' | 'ham'
): Promise<MoveResult> {
	// One decision per mailbox across the grouping and the moves.
	const access = createMailboxAccessGate(ctx, session);
	const groups = await roleFolderGroups(ctx, access, messageIds, role);
	for (const id of groups.flatMap((group) => group.messageIds)) {
		await ctx.db.patch(id, { spamVerdict: verdict, updatedAt: Date.now() });
	}
	return await moveGroups(ctx, access, groups);
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
