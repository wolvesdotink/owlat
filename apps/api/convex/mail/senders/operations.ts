/**
 * Sender-status changes as undoable operations (SPEC §2.9, §4.4, §5).
 *
 * Every change writes its `mailArrivalOperations` header and its
 * `mailArrivalOperationChanges` rows (built by `arrivalChangeRow`) in the SAME
 * mutation as the change itself, and stamps `lastOperationId` on the profile
 * (the ABA guard undo checks). Message-level rows (`messageFolder`) carry no
 * operation marker on the message; undo checks their value only.
 *
 * After a status change the sender's threads are re-sorted: placement is
 * derived, so recomputing the projections of the sender's newest ≤200 inbox
 * threads re-sorts them, the first batch inline and the rest by a bounded
 * chain (§16, `./resortChain.ts`). `auto_archive` and `unsubscribed` also archive the
 * sender's newest ≤200 Inbox messages through `moveMessagesToFolder` (provider
 * writeback included), each logged as a `messageFolder` change. Older mail
 * stays where it is; there is no continuation.
 *
 * Isolate-safe helpers, no Convex functions.
 */

import type { SenderStatus, SenderStatusSource } from '@owlat/shared/arrival';
import type { Doc, Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { ARRIVAL_RETENTION_MS, arrivalChangeRow } from '../arrival/changeRows';
import { moveMessagesToFolder } from '../messageActions';
import { refreshThreadsBounded } from './resortBatch';

/** The newest Inbox messages (and their threads) one status change touches. */
export const SENDER_RESORT_LIMIT = 200;

type OperationKind = Doc<'mailArrivalOperations'>['kind'];
type OperationActor = Doc<'mailArrivalOperations'>['actor'];

export async function startSenderOperation(
	ctx: MutationCtx,
	args: {
		mailboxId: Id<'mailboxes'>;
		kind: OperationKind;
		actor: OperationActor;
		senderDigest?: string;
		threadId?: Id<'mailThreads'>;
		messageId?: Id<'mailMessages'>;
		/** Already sealed (`sealBodyAtWrite`). */
		reason?: string;
		now: number;
	}
): Promise<Id<'mailArrivalOperations'>> {
	return await ctx.db.insert('mailArrivalOperations', {
		mailboxId: args.mailboxId,
		kind: args.kind,
		actor: args.actor,
		...(args.senderDigest ? { senderDigest: args.senderDigest } : {}),
		...(args.threadId ? { threadId: args.threadId } : {}),
		...(args.messageId ? { messageId: args.messageId } : {}),
		...(args.reason ? { reason: args.reason } : {}),
		changeCount: 0,
		status: 'applied',
		createdAt: args.now,
		expiresAt: args.now + ARRIVAL_RETENTION_MS.operation,
	});
}

/** Add `count` written change rows to an operation's header. */
export async function addOperationChanges(
	ctx: MutationCtx,
	operationId: Id<'mailArrivalOperations'>,
	count: number
): Promise<void> {
	if (count === 0) return;
	const operation = await ctx.db.get(operationId);
	if (operation) await ctx.db.patch(operationId, { changeCount: operation.changeCount + count });
}

/**
 * Set a profile's status and log it. Returns false (and writes nothing) when
 * the profile already has that status and source.
 */
export async function writeSenderStatus(
	ctx: MutationCtx,
	args: {
		profile: Doc<'mailSenderProfiles'>;
		status: SenderStatus;
		statusSource: SenderStatusSource;
		operationId: Id<'mailArrivalOperations'>;
		now: number;
	}
): Promise<boolean> {
	const { profile } = args;
	if (profile.status === args.status && profile.statusSource === args.statusSource) return false;
	await ctx.db.patch(profile._id, {
		status: args.status,
		statusSource: args.statusSource,
		statusChangedAt: args.now,
		statusOperationId: args.operationId,
		lastOperationId: args.operationId,
		updatedAt: args.now,
	});
	await ctx.db.insert(
		'mailArrivalOperationChanges',
		arrivalChangeRow({
			operationId: args.operationId,
			mailboxId: profile.mailboxId,
			change: {
				kind: 'senderStatus',
				senderDigest: profile.senderDigest,
				before: { status: profile.status, statusSource: profile.statusSource },
				after: { status: args.status, statusSource: args.statusSource },
			},
			now: args.now,
		})
	);
	return true;
}

/** The mailbox's system folder of a role, or null. */
export async function folderId(
	ctx: MutationCtx,
	mailboxId: Id<'mailboxes'>,
	role: 'inbox' | 'archive'
): Promise<Id<'mailFolders'> | null> {
	const folder = await ctx.db
		.query('mailFolders')
		.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailboxId).eq('role', role))
		.first();
	return folder?._id ?? null;
}

/**
 * The sender's newest ≤200 Inbox messages by arrival time (`receivedAt`), from
 * the folder-qualified index: mail in other folders never crowds the Inbox out
 * of the page, and history imported later never displaces newer mail.
 */
async function senderInboxMessages(
	ctx: MutationCtx,
	profile: Pick<Doc<'mailSenderProfiles'>, 'address'>,
	inboxId: Id<'mailFolders'>
): Promise<Doc<'mailMessages'>[]> {
	return await ctx.db
		.query('mailMessages')
		.withIndex('by_folder_from_received', (q) =>
			q.eq('folderId', inboxId).eq('fromAddress', profile.address)
		)
		.order('desc')
		.take(SENDER_RESORT_LIMIT);
}

/**
 * Archive the sender's newest ≤200 Inbox messages, logging each move, and
 * re-sort their threads. Returns how many moved.
 */
export async function archiveSenderInbox(
	ctx: MutationCtx,
	args: {
		profile: Pick<Doc<'mailSenderProfiles'>, 'mailboxId' | 'address'>;
		operationId: Id<'mailArrivalOperations'>;
		now: number;
	}
): Promise<number> {
	const { mailboxId } = args.profile;
	const [inboxId, archiveId] = await Promise.all([
		folderId(ctx, mailboxId, 'inbox'),
		folderId(ctx, mailboxId, 'archive'),
	]);
	if (!inboxId || !archiveId) return 0;
	const messages = await senderInboxMessages(ctx, args.profile, inboxId);
	if (messages.length === 0) return 0;

	// The reply-queue verdicts the move will clear, which undo cannot restore
	// (§4.4): flagged on the first logged row of each such thread.
	const threadIds = [...new Set(messages.map((message) => message.threadId))];
	const repliesPending = new Set<Id<'mailThreads'>>();
	for (const threadId of threadIds) {
		const thread = await ctx.db.get(threadId);
		if (thread?.needsReply) repliesPending.add(threadId);
	}

	const threadOf = new Map(messages.map((message) => [message._id, message.threadId]));
	const { moved } = await moveMessagesToFolder(ctx, {
		messageIds: messages.map((message) => message._id),
		targetFolderId: archiveId,
	});
	for (const row of moved) {
		const threadId = threadOf.get(row.messageId);
		const isNeedsReplyCleared = threadId !== undefined && repliesPending.delete(threadId);
		await ctx.db.insert(
			'mailArrivalOperationChanges',
			arrivalChangeRow({
				operationId: args.operationId,
				mailboxId,
				change: {
					kind: 'messageFolder',
					messageId: row.messageId,
					before: row.sourceFolderId,
					after: archiveId,
				},
				isNeedsReplyCleared,
				now: args.now,
			})
		);
	}
	await refreshThreadsBounded(ctx, threadIds);
	return moved.length;
}

/**
 * Re-sort the sender's newest ≤200 Inbox threads (placement is derived): the
 * first batch now, the rest of that same set by a bounded chain (§16,
 * `./resortChain.ts`). `undoOperationId` ties the chain to an undo's progress.
 * Returns how many Inbox messages the page covered and whether a chain runs.
 */
export async function resortSenderThreads(
	ctx: MutationCtx,
	profile: Pick<Doc<'mailSenderProfiles'>, 'mailboxId' | 'address'>,
	opts: { undoOperationId?: Id<'mailArrivalOperations'> } = {}
): Promise<{ resorted: number; isContinued: boolean }> {
	const inboxId = await folderId(ctx, profile.mailboxId, 'inbox');
	if (!inboxId) return { resorted: 0, isContinued: false };
	const messages = await senderInboxMessages(ctx, profile, inboxId);
	const threadIds = [...new Set(messages.map((message) => message.threadId))];
	const { isContinued } = await refreshThreadsBounded(ctx, threadIds, opts);
	return { resorted: messages.length, isContinued };
}

/** Whether a status files the sender's mail away (and so archives what is there). */
export function isArchivingStatus(status: SenderStatus): boolean {
	return status === 'auto_archive' || status === 'unsubscribed';
}

/**
 * One sender-status change as one operation: the status, then the archive
 * (archiving statuses) or the re-sort (the others). Returns null when the
 * status was already set.
 */
export async function changeSenderStatus(
	ctx: MutationCtx,
	args: {
		profile: Doc<'mailSenderProfiles'>;
		status: SenderStatus;
		statusSource: SenderStatusSource;
		kind: OperationKind;
		actor: OperationActor;
	}
): Promise<{ operationId: Id<'mailArrivalOperations'>; archived: number } | null> {
	const { profile } = args;
	if (profile.status === args.status && profile.statusSource === args.statusSource) return null;
	const now = Date.now();
	const operationId = await startSenderOperation(ctx, {
		mailboxId: profile.mailboxId,
		kind: args.kind,
		actor: args.actor,
		senderDigest: profile.senderDigest,
		now,
	});
	await writeSenderStatus(ctx, { ...args, operationId, now });
	let archived = 0;
	if (isArchivingStatus(args.status)) {
		archived = await archiveSenderInbox(ctx, { profile, operationId, now });
	} else {
		await resortSenderThreads(ctx, profile);
	}
	await addOperationChanges(ctx, operationId, 1 + archived);
	return { operationId, archived };
}
