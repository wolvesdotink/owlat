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
type Ctx = Pick<ActionCtx, 'runQuery' | 'runMutation' | 'storage'>;

/** The forwarded parts of a raw message, by part index; null when it cannot be read. */
async function readForwardedParts(
	ctx: Ctx,
	rawStorageId: Id<'_storage'>
): Promise<Map<string, ExtractedAttachment> | null> {
	const raw = await readSealedBlobBytes(ctx.storage, rawStorageId).catch(() => null);
	if (!raw) return null;
	// One char per byte, so binary parts survive the MIME walk.
	const eml = new TextDecoder('latin1').decode(raw);
	return new Map(forwardedParts(eml).map(({ partIndex, part }) => [partIndex, part]));
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
	const parts = await readForwardedParts(ctx, job.rawStorageId);
	if (!parts) {
		if (job.debtKey) failed.push({ key: job.debtKey, filename: '', reason: 'unreadable' });
		for (const partIndex of job.partIndexes) {
			const key = forwardPartKey(job.messageId, partIndex);
			failed.push({ key, filename: '', reason: 'unreadable' });
		}
		return;
	}
	let owed = job.partIndexes;
	if (job.debtKey) {
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
