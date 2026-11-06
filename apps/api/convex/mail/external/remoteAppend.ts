/**
 * Mail moved or copied INTO a connected (IMAP) account from another mailbox
 * (`mail/mailboxTransfer.ts`).
 *
 * Owlat writes the copy at once, and an `append` write-back has the worker
 * upload it to the provider (`apps/mail-sync/src/remoteOps.ts`). Until that
 * upload has landed the copy exists only here, and a connected account's mail
 * lives at the provider, so a MOVE keeps its original: the op names it
 * (`append.sourceMessageId`) and only a settled upload purges it. A failed or
 * impossible upload purges the copy instead, so the message is where it was
 * and nowhere twice.
 *
 * What a member does to the copy meanwhile is recorded as usual, as ops for
 * the same message, and those wait behind the upload (`remoteOpOrder.ts`), so
 * none of them is lost to a race with an upload already in flight. The upload
 * reads its bytes through the copy, or through the original once the copy is
 * gone, so a copy deleted before its upload ran still leaves a move consistent:
 * uploaded, then deleted.
 */

import { v } from 'convex/values';
import { internalQuery, type MutationCtx, type QueryCtx } from '../../_generated/server';
import type { Doc, Id } from '../../_generated/dataModel';
import { purgeMessageRow, purgeThreadBriefsOf, type PurgedMessages } from '../messagePurge';
import { rebuildThreadAggregates } from '../threadAggregates';

type RemoteOpRow = Doc<'externalMailRemoteOps'>;

/** A message's queued ops an upload is looked for among; the same bound the queue orders by. */
const MESSAGE_OPS_LIMIT = 25;

/**
 * The queued upload of `copy`, which a connected account holds only in Owlat
 * until it has run, or null when there is none.
 */
export async function pendingAppendOf(
	ctx: QueryCtx,
	copy: Pick<Doc<'mailMessages'>, '_id' | 'mailboxId' | 'rfc822MessageId'>
): Promise<RemoteOpRow | null> {
	const accounts = await ctx.db
		.query('externalMailAccounts')
		.withIndex('by_mailbox', (q) => q.eq('mailboxId', copy.mailboxId))
		.collect(); // bounded: one live account per mailbox, plus the disconnected ones a re-attach left
	for (const account of accounts) {
		const ops = await ctx.db
			.query('externalMailRemoteOps')
			.withIndex('by_account_and_message', (q) =>
				q.eq('accountId', account._id).eq('rfc822MessageId', copy.rfc822MessageId)
			)
			.take(MESSAGE_OPS_LIMIT);
		const op = ops.find((o) => o.kind === 'append' && o.append?.messageId === copy._id);
		if (op) return op;
	}
	return null;
}

/**
 * What an `append` op carries for `copy`: the flags it is uploaded with and
 * the transfer it finishes; a move names its original.
 */
export function appendOpFields(
	copy: Doc<'mailMessages'>,
	sourceMessageId: Id<'mailMessages'> | undefined
): Pick<RemoteOpRow, 'flags' | 'append'> {
	return {
		flags: { seen: copy.flagSeen, flagged: copy.flagFlagged, answered: copy.flagAnswered },
		append: {
			messageId: copy._id,
			receivedAt: copy.receivedAt,
			...(sourceMessageId ? { sourceMessageId } : {}),
		},
	};
}

/** Purge rows outside any member's action: the thread briefs and aggregates follow. */
async function purgeRows(ctx: MutationCtx, rows: Doc<'mailMessages'>[]): Promise<void> {
	const purged: PurgedMessages = new Map();
	const threads = new Set<Id<'mailThreads'>>();
	for (const row of rows) threads.add(await purgeMessageRow(ctx, row, purged));
	await purgeThreadBriefsOf(ctx, purged);
	for (const threadId of threads) await rebuildThreadAggregates(ctx, threadId);
}

/**
 * The upload landed: a move now purges its original. Returns the purged row,
 * whose delete the caller records for the original's own provider when that
 * is a connected account too (`remoteOps.ts`, which this module must not
 * import back).
 */
export async function finishAppend(
	ctx: MutationCtx,
	op: RemoteOpRow
): Promise<Doc<'mailMessages'> | null> {
	const sourceId = op.append?.isRecalled ? undefined : op.append?.sourceMessageId;
	const source = sourceId ? await ctx.db.get(sourceId) : null;
	if (!source) return null;
	await purgeRows(ctx, [source]);
	return source;
}

/**
 * The upload will not happen (the worker could not run it, or there was
 * nothing left to upload): the copy goes, and a move's original stays.
 */
export async function abandonAppend(
	ctx: MutationCtx,
	op: RemoteOpRow,
	reason: string
): Promise<void> {
	const copyId = op.append?.messageId;
	const copy = copyId ? await ctx.db.get(copyId) : null;
	if (!copy) return;
	await purgeRows(ctx, [copy]);
	await ctx.db.insert('mailAuditLog', {
		mailboxId: copy.mailboxId,
		event: 'transfer_upload_failed',
		details: JSON.stringify({ messageId: copy.rfc822MessageId, reason: reason.slice(0, 500) }),
		occurredAt: Date.now(),
	});
}

/**
 * The stored raw `.eml` an `append` op uploads (`GET /mail-sync/raw-message`),
 * or null when the op is gone, is not an upload, or both its copy and its
 * original are gone.
 */
export const appendRawSource = internalQuery({
	args: { opId: v.string() },
	returns: v.union(v.id('_storage'), v.null()),
	handler: async (ctx, args) => {
		const opId = ctx.db.normalizeId('externalMailRemoteOps', args.opId);
		const op = opId ? await ctx.db.get(opId) : null;
		if (!op || op.kind !== 'append' || !op.append) return null;
		const copy = await ctx.db.get(op.append.messageId);
		if (copy) return copy.rawStorageId;
		const source = op.append.sourceMessageId ? await ctx.db.get(op.append.sourceMessageId) : null;
		return source?.rawStorageId ?? null;
	},
});
