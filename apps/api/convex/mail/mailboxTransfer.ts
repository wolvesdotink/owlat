/**
 * Move or copy messages from one mailbox to another: the "Other mailboxes"
 * half of the Postbox move picker.
 *
 * A move is a copy followed by a purge of the source, in ONE transaction: the
 * source row is deleted only after the target row is written, and if anything
 * refuses, neither happens. Read, star, answered and label state travel with
 * the message (`mailboxTransferCopy.ts`). The client undoes a move by moving
 * the copies back, and a copy by purging the copies.
 *
 * Connected (IMAP) accounts: a move out of one deletes the provider's copy
 * with the usual write-back. Into one, the copy is written here at once and
 * uploaded by the worker (an `append` write-back), and a move keeps its
 * source until that upload has landed: the account's mail lives at the
 * provider, and a row only Owlat holds would vanish with the account
 * (`external/remoteAppend.ts`). The undo of such a move, while the upload is
 * still queued, keeps the original and lets the copy go.
 *
 * What a transfer refuses, each with a `reason` the client words:
 *   - `external_target`: the target is a connected account that takes no
 *     mail from Owlat (disconnected, or set to receive new mail only).
 *   - `no_message_id`: into a connected account, a message whose Message-ID
 *     the worker invented. The provider could never find the upload by it,
 *     and the next sync would import it as a second message.
 *   - `sealed`: a sealed (end-to-end encrypted) message bound for a mailbox
 *     on another address. Only the address it was sealed to holds the key, so
 *     it may only travel between mailboxes on that same address.
 *   - `sending`: a sent message with a recipient still queued; the
 *     transport's updates address the source row.
 *   - `over_quota`: the target has no room for the batch.
 *
 * Mailbox scope: the target must be on the caller's own rail (their mailbox,
 * or a team inbox they are a member of), never a teammate's personal mailbox
 * an org admin could otherwise reach. The source needs the access a purge
 * there needs. A message already in the target (same Message-ID) is skipped,
 * not duplicated, and stays where it was.
 */

import { v } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { postboxMutation } from './_helpers';
import { createMailboxAccessGate } from './permissions';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import { mailboxScope } from './mailbox/shared';
import { isOverQuota } from './deliveryPipeline/insert';
import { withMailboxUsage } from './mailboxUsage';
import { purgeMessageRow, purgeThreadBriefsOf, type PurgedMessages } from './messagePurge';
import { rebuildThreadAggregates } from './threadAggregates';
import { insertMessageCopy, type LabelMap } from './mailboxTransferCopy';
import {
	hasSyntheticMessageId,
	liveAccountFor,
	recordRemoteChanges,
	type RemoteChange,
} from './external/remoteOps';
import { pendingAppendOf } from './external/remoteAppend';
import { throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';

/**
 * Most messages one transfer is given. A copy re-threads, maps labels and
 * writes counters in the target, and a move then purges the source, so each
 * message costs several times an in-mailbox move's index reads. The client
 * sends longer selections in calls of this size.
 */
export const MAX_MESSAGES_PER_TRANSFER = 25;

export type TransferRefusal =
	| 'external_target'
	| 'no_message_id'
	| 'sealed'
	| 'sending'
	| 'over_quota';

type TransferResult = {
	ok: true;
	/** Each copy with the folder its source sat in, which the undo of a move returns it to. */
	moved: Array<{ messageId: Id<'mailMessages'>; sourceFolderId: Id<'mailFolders'> }>;
	/** Messages the target already held, left where they were. */
	skipped: Id<'mailMessages'>[];
	/**
	 * The target is a connected account: the copies are on their way to its
	 * provider, and a move's sources stay until each has arrived.
	 */
	uploading: boolean;
};

/** A pending copy moved back to where its original still is: the undo of a move into a connected account. */
type Recall = {
	copy: Doc<'mailMessages'>;
	op: Doc<'externalMailRemoteOps'>;
	original: Doc<'mailMessages'>;
};

function refuse(reason: TransferRefusal, message: string): never {
	throwInvalidState(message, { reason });
}

/** Is `mailbox` on the caller's own rail: theirs, or a team inbox they belong to? */
async function isOnCallersRail(
	ctx: MutationCtx,
	mailbox: Doc<'mailboxes'>,
	userId: string
): Promise<boolean> {
	if (mailboxScope(mailbox) === 'seed') return false;
	if (mailbox.userId === userId) return true;
	const membership = await ctx.db
		.query('mailboxMembers')
		.withIndex('by_mailbox_user', (q) => q.eq('mailboxId', mailbox._id).eq('authUserId', userId))
		.unique();
	return membership !== null;
}

/** Whether a message is sealed: arrived encrypted, or was sent sealed. */
function isSealed(message: Doc<'mailMessages'>): boolean {
	return message.inboundEncryptionInfo !== undefined || message.encryptionInfo?.isSealed === true;
}

async function resolveTarget(
	ctx: MutationCtx,
	session: MutationSessionContext,
	access: ReturnType<typeof createMailboxAccessGate>,
	args: { targetMailboxId: Id<'mailboxes'>; targetFolderId?: Id<'mailFolders'> }
): Promise<{ mailbox: Doc<'mailboxes'>; folder: Doc<'mailFolders'>; connected: boolean }> {
	const owned = await access(args.targetMailboxId);
	if (!owned.ok || !(await isOnCallersRail(ctx, owned.mailbox, session.userId))) {
		throwForbidden('Mailbox not accessible');
	}
	const mailbox = owned.mailbox;
	const connected = mailbox.kind === 'external';
	if (connected && !(await liveAccountFor(ctx, mailbox._id))) {
		refuse('external_target', 'This connected account takes no mail from Owlat');
	}
	const folder = args.targetFolderId
		? await ctx.db.get(args.targetFolderId)
		: await ctx.db
				.query('mailFolders')
				.withIndex('by_mailbox_and_role', (q) => q.eq('mailboxId', mailbox._id).eq('role', 'inbox'))
				.first();
	if (!folder || folder.mailboxId !== mailbox._id) throwInvalidInput('Folder not in that mailbox');
	return { mailbox, folder, connected };
}

/**
 * The messages that travel: readable, in another mailbox, and not already in
 * the target. Throws for the first one the target must not receive, so a
 * refused batch changes nothing.
 */
async function collectSources(
	ctx: MutationCtx,
	access: ReturnType<typeof createMailboxAccessGate>,
	args: { messageIds: Id<'mailMessages'>[]; mode: 'move' | 'copy' },
	target: { mailbox: Doc<'mailboxes'>; connected: boolean }
): Promise<{ sources: Doc<'mailMessages'>[]; skipped: Id<'mailMessages'>[]; recalls: Recall[] }> {
	const sources: Doc<'mailMessages'>[] = [];
	const recalls: Recall[] = [];
	const seen = new Set<Id<'mailMessages'>>();
	const messageIds = new Set<string>();
	const skipped: Id<'mailMessages'>[] = [];
	for (const id of args.messageIds) {
		if (seen.has(id)) continue;
		seen.add(id);
		const message = await ctx.db.get(id);
		if (!message || message.mailboxId === target.mailbox._id) continue;
		const owned = await access(message.mailboxId);
		if (!owned.ok) continue;
		if (target.connected && hasSyntheticMessageId(message)) {
			refuse('no_message_id', 'This message has no Message-ID a connected account can keep');
		}
		if (isSealed(message) && owned.mailbox.address !== target.mailbox.address) {
			refuse('sealed', 'A sealed message can only move to a mailbox that can open it');
		}
		// `partial` can still hold queued recipients, whose updates address this row.
		if (message.outbound?.recipients.some((r) => r.state === 'queued')) {
			refuse('sending', 'This message is still being sent');
		}
		// The column is already canonical, so it is matched as stored.
		const duplicate = await ctx.db
			.query('mailMessages')
			.withIndex('by_mailbox_and_rfc822_message_id', (q) =>
				q.eq('mailboxId', target.mailbox._id).eq('rfc822MessageId', message.rfc822MessageId)
			)
			.first();
		if (duplicate && args.mode === 'move') {
			const op = await pendingAppendOf(ctx, message);
			if (op?.append?.sourceMessageId === duplicate._id) {
				recalls.push({ copy: message, op, original: duplicate });
				continue;
			}
		}
		if (duplicate || messageIds.has(message.rfc822MessageId)) {
			skipped.push(id);
			continue;
		}
		messageIds.add(message.rfc822MessageId);
		sources.push(message);
	}
	return { sources, skipped, recalls };
}

/**
 * Undo a move into a connected account whose upload has not settled: the
 * original never left, so it stays, and the copy goes. The upload may already
 * be in flight, so it is left to run and the copy's delete is queued behind
 * it; only the purge of the original it would have done is taken back.
 */
async function recall(
	ctx: MutationCtx,
	recalls: Recall[],
	remote: RemoteChange[]
): Promise<TransferResult['moved']> {
	const purged: PurgedMessages = new Map();
	const threads = new Set<Id<'mailThreads'>>();
	for (const { copy, op } of recalls) {
		await ctx.db.patch(op._id, { append: { ...op.append!, isRecalled: true } });
		threads.add(await purgeMessageRow(ctx, copy, purged));
		remote.push({ kind: 'delete', message: copy });
	}
	await purgeThreadBriefsOf(ctx, purged);
	for (const threadId of threads) await rebuildThreadAggregates(ctx, threadId);
	return recalls.map(({ copy, original }) => ({
		messageId: original._id,
		sourceFolderId: copy.folderId,
	}));
}

/** Move or copy messages into another mailbox (its Inbox unless a folder is named). */
// authz: the target through createMailboxAccessGate plus isOnCallersRail; each
// source through the same gate a purge there uses.
export const transfer = postboxMutation({
	args: {
		messageIds: v.array(v.id('mailMessages')),
		targetMailboxId: v.id('mailboxes'),
		targetFolderId: v.optional(v.id('mailFolders')),
		mode: v.union(v.literal('move'), v.literal('copy')),
	},
	handler: async (ctx, args, session): Promise<TransferResult> => {
		if (args.messageIds.length > MAX_MESSAGES_PER_TRANSFER) {
			throwInvalidInput(`At most ${MAX_MESSAGES_PER_TRANSFER} messages per call`);
		}
		const access = createMailboxAccessGate(ctx, session);
		const { mailbox, folder, connected } = await resolveTarget(ctx, session, access, args);
		const { sources, skipped, recalls } = await collectSources(ctx, access, args, {
			mailbox,
			connected,
		});
		const remote: RemoteChange[] = [];
		const recalled = await recall(ctx, recalls, remote);
		if (sources.length === 0) {
			await recordRemoteChanges(ctx, remote);
			return { ok: true, moved: recalled, skipped, uploading: connected };
		}

		const bytes = sources.reduce((sum, m) => sum + m.rawSize, 0);
		if (isOverQuota(await withMailboxUsage(ctx.db, mailbox), bytes)) {
			refuse('over_quota', 'The target mailbox is full');
		}

		const now = Date.now();
		const labelMap: LabelMap = new Map();
		const targetThreads = new Set<Id<'mailThreads'>>();
		const moved: TransferResult['moved'] = [...recalled];
		let uid = folder.uidNext;
		let modseq = folder.highestModseq + 1;
		let unseen = 0;
		for (const message of sources) {
			const copy = await insertMessageCopy(
				ctx,
				message,
				{ mailbox, folder, uid: uid++, modseq: modseq++ },
				labelMap,
				now
			);
			if (!message.flagSeen) unseen++;
			targetThreads.add(copy.threadId);
			moved.push({ messageId: copy.messageId, sourceFolderId: message.folderId });
			const written = connected ? await ctx.db.get(copy.messageId) : null;
			if (written) {
				remote.push({
					kind: 'append',
					message: written,
					...(args.mode === 'move' ? { sourceMessageId: message._id } : {}),
				});
			}
		}
		await ctx.db.patch(folder._id, {
			uidNext: uid,
			highestModseq: modseq - 1,
			totalCount: folder.totalCount + sources.length,
			unseenCount: folder.unseenCount + unseen,
			updatedAt: now,
		});
		for (const threadId of targetThreads) await rebuildThreadAggregates(ctx, threadId);

		// Only now, with every copy written, does a move delete its sources; into
		// a connected account, only once each upload has landed.
		if (args.mode === 'move' && !connected) {
			const purged: PurgedMessages = new Map();
			const sourceThreads = new Set<Id<'mailThreads'>>();
			for (const message of sources) {
				sourceThreads.add(await purgeMessageRow(ctx, message, purged));
				// A no-op for a hosted mailbox; a connected one deletes the provider's copy.
				remote.push({ kind: 'delete', message });
			}
			await purgeThreadBriefsOf(ctx, purged);
			for (const threadId of sourceThreads) await rebuildThreadAggregates(ctx, threadId);
		}
		await recordRemoteChanges(ctx, remote);

		await ctx.db.insert('mailAuditLog', {
			mailboxId: mailbox._id,
			event: args.mode === 'move' ? 'transfer_in' : 'copy_in',
			details: JSON.stringify({
				byUserId: session.userId,
				from: [...new Set(sources.map((m) => m.mailboxId))],
				count: sources.length,
				folder: folder.role ?? folder.name,
			}),
			occurredAt: now,
		});
		return { ok: true, moved, skipped, uploading: connected };
	},
});
