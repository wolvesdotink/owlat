'use node';

/**
 * `fulfil`: copy every file a draft owes onto it (#1257; the debt itself is
 * `draftExpectedAttachments.ts`). Safe to run from any number of tabs at once.
 *
 * A forward is read once, from its raw message: `forwardedParts` picks the
 * parts (the disposition rule forwarding has always used), the debt is
 * expanded into one entry per picked part keyed by its raw part index, and
 * each part's bytes come from that same parse. Selection and copying use one
 * source and one identity; nothing is matched against the message row's
 * attachment list.
 *
 * MEMORY. A raw message is held as bytes and as a binary string while it is
 * walked, and the parts a forward carries are decoded (the rest are not), so a
 * read peaks at a few times the message's size. A Node action has room for
 * any message the MX and IMAP APPEND accept (10 and 50 MiB); past
 * `MAX_FORWARD_RAW_BYTES` the message is not read at all and the forward stays
 * owed as `messageTooLarge`. A walk the MIME bounds cut short (parts, depth)
 * is not expanded either (`messageTooComplex`): the parts past the cut were
 * never seen, so expanding would drop them without a word.
 */

import { v } from 'convex/values';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { forwardedParts, type ExtractedAttachment } from '@owlat/shared/mailMime';
import { authedAction } from '../lib/authedFunctions';
import { readSealedBlobBytes } from '../lib/sealedBlob';
import { forwardPartKey, type FulfilFailure, type OwedWork } from './draftExpectedAttachments';

type Failed = Array<{ key: string; filename: string; reason: FulfilFailure }>;

/** Largest raw message a forward is read from (see MEMORY above). */
export const MAX_FORWARD_RAW_BYTES = 64 * 1024 * 1024;
type Ctx = Pick<ActionCtx, 'runQuery' | 'runMutation' | 'storage'>;

/**
 * The forwarded parts of a raw message, by part index, or why they cannot be
 * known: too large to read, unreadable, or cut short by the walker's bounds.
 */
async function readForwardedParts(
	ctx: Ctx,
	job: Extract<OwedWork, { kind: 'forward' }>
): Promise<
	| { parts: Map<string, ExtractedAttachment>; truncated: boolean }
	| { failure: 'messageTooLarge' | 'unreadable' }
> {
	if (job.rawSize > MAX_FORWARD_RAW_BYTES) return { failure: 'messageTooLarge' };
	const raw = await readSealedBlobBytes(ctx.storage, job.rawStorageId).catch(() => null);
	if (!raw) return { failure: 'unreadable' };
	// One char per byte, so binary parts survive the MIME walk.
	const read = forwardedParts(new TextDecoder('latin1').decode(raw));
	return {
		parts: new Map(read.parts.map(({ partIndex, part }) => [partIndex, part])),
		truncated: read.truncated,
	};
}

/** Store, receipt and bind one copy; the reason it stays owed, or null once bound. */
async function copyOn(
	ctx: Ctx,
	draftId: Id<'mailDrafts'>,
	key: string,
	bytes: Uint8Array,
	contentType: string
): Promise<FulfilFailure | null> {
	if (bytes.byteLength === 0) return 'unreadable';
	if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return 'tooLarge';
	const storageId = await ctx.storage.store(new Blob([bytes as BlobPart], { type: contentType }));
	try {
		await ctx.runMutation(internal.mail.draftExpectedAttachments.stageCopy, { storageId });
	} catch {
		// Not receipted, so nothing else would find it: delete it now.
		await ctx.storage.delete(storageId);
		return 'failed';
	}
	let outcome: 'bound' | 'taken' | 'tooLarge' | 'tooMany' | 'totalTooLarge' | 'failed';
	try {
		({ outcome } = await ctx.runMutation(internal.mail.draftExpectedAttachments.bindExpected, {
			draftId,
			key,
			storageId,
		}));
	} catch {
		outcome = 'failed';
	}
	if (outcome === 'bound') return null;
	// The receipt stays until this lands; failing that, the upload sweep takes it.
	await ctx
		.runMutation(internal.mail.draftExpectedAttachments.dropCopy, { storageId })
		.catch(() => undefined);
	return outcome === 'taken' ? null : outcome;
}

/** Expand (once) and copy one forwarded message's parts. */
async function fulfilForward(
	ctx: Ctx,
	draftId: Id<'mailDrafts'>,
	job: Extract<OwedWork, { kind: 'forward' }>,
	failed: Failed
): Promise<void> {
	const read = await readForwardedParts(ctx, job);
	if ('failure' in read) {
		if (job.debtKey) failed.push({ key: job.debtKey, filename: '', reason: read.failure });
		for (const partIndex of job.partIndexes) {
			const key = forwardPartKey(job.messageId, partIndex);
			failed.push({ key, filename: '', reason: read.failure });
		}
		return;
	}
	const { parts } = read;
	let owed = job.partIndexes;
	if (job.debtKey && read.truncated) {
		// Parts past the cut were never seen: keep the whole forward owed.
		failed.push({ key: job.debtKey, filename: '', reason: 'messageTooComplex' });
	} else if (job.debtKey) {
		const expanded = await ctx.runMutation(internal.mail.draftExpectedAttachments.expandForward, {
			draftId,
			key: job.debtKey,
			parts: [...parts].map(([partIndex, part]) => ({
				partIndex,
				filename: part.filename,
				contentType: part.contentType,
				size: part.bytes.byteLength,
			})),
		});
		if (expanded.outcome === 'tooMany') {
			failed.push({ key: job.debtKey, filename: '', reason: 'tooMany' });
			return;
		}
		owed = expanded.owed;
	}
	for (const partIndex of owed) {
		const key = forwardPartKey(job.messageId, partIndex);
		const part = parts.get(partIndex);
		const reason = part
			? await copyOn(ctx, draftId, key, part.bytes, part.contentType)
			: 'unreadable';
		if (reason) failed.push({ key, filename: part?.filename ?? '', reason });
	}
}

/**
 * Copy every file the draft owes onto it. Returns the keys that stay owed and
 * why (a forwarded part's filename, or '' for an unexpanded forward).
 */
export async function fulfilExpectedAttachments(
	ctx: Ctx,
	args: { draftId: Id<'mailDrafts'> }
): Promise<{ failed: Failed }> {
	const work: OwedWork[] = await ctx.runQuery(
		internal.mail.draftExpectedAttachments.owedWork,
		args
	);
	const failed: Failed = [];
	for (const job of work) {
		if (job.kind === 'unreadable') {
			failed.push({ key: job.key, filename: job.filename, reason: 'unreadable' });
		} else if (job.kind === 'generated') {
			const bytes = new TextEncoder().encode(job.content);
			const reason = await copyOn(ctx, args.draftId, job.key, bytes, job.contentType);
			if (reason) failed.push({ key: job.key, filename: job.filename, reason });
		} else {
			await fulfilForward(ctx, args.draftId, job, failed);
		}
	}
	return { failed };
}

/**
 * Copy what the draft owes onto it (the composer runs this whenever a draft it
 * shows owes a file; another tab running it too is harmless).
 */
// authz: owedWork checks the caller can write the draft (and read each forwarded message); expandForward and bindExpected re-check the draft.
export const fulfil = authedAction({
	args: { draftId: v.id('mailDrafts') },
	handler: async (ctx, args) => fulfilExpectedAttachments(ctx, args),
});
