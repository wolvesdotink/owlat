'use node';

/**
 * `fulfil`: copy every file a draft owes onto it (#1257; the debt itself is
 * `draftExpectedAttachments.ts`). Safe to run from any number of tabs at once.
 *
 * A forward is read once, from its raw message: `locateForwardedParts` picks
 * the parts (the disposition rule forwarding has always used), the debt is
 * expanded into one entry per picked part keyed by its raw part index, and
 * each part's bytes come from that same parse. Selection and copying use one
 * source and one identity; nothing is matched against the message row's
 * attachment list. A walk the MIME bounds cut short (parts, depth) is not
 * expanded (`messageTooComplex`): the parts past the cut were never seen.
 *
 * MEMORY. The message is never turned into a string. It is read and unsealed
 * as it streams, into one array of its plaintext size
 * (`readSealedBlobBytesStreaming`; the stored blob and its plaintext are the
 * only full copies), its parts are located by byte searches within header
 * budgets (`locateMimeTree`), and only the parts a forward carries are
 * decoded, one at a time, in constant extra memory, each straight into an
 * array of its exact decoded size, which is counted first: a part over the
 * per-file limit is never decoded (`tooLarge`). Past `MAX_FORWARD_RAW_BYTES`
 * (the IMAP APPEND limit, the largest message any path stores) the message is
 * not read at all and the forward stays owed as `messageTooLarge`.
 * `convex/__tests__/forwardMemory.test.ts` measures this path in separate Node
 * processes over adversarial messages: at most about 270 MiB of a Node
 * action's 512.
 */

import { v } from 'convex/values';
import type { ActionCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { MAX_ATTACHMENT_BYTES, MAX_FORWARD_RAW_BYTES } from '@owlat/shared/attachments';
import { locateForwardedParts, type LocatedForwardedPart } from '@owlat/shared/mailMime';
import { authedAction } from '../lib/authedFunctions';
import { readSealedBlobBytesStreaming } from '../lib/sealedBlobStream';
import { getOptional } from '../lib/env';
import { forwardPartKey, type FulfilFailure, type OwedWork } from './draftExpectedAttachments';

type Failed = Array<{ key: string; filename: string; reason: FulfilFailure }>;

type Ctx = Pick<ActionCtx, 'runQuery' | 'runMutation' | 'storage'>;

/**
 * The forwarded parts of a raw message, by part index, or why they cannot be
 * known: too large to read, unreadable, or cut short by the walker's bounds.
 */
async function readForwardedParts(
	ctx: Ctx,
	job: Extract<OwedWork, { kind: 'forward' }>
): Promise<
	| { parts: Map<string, LocatedForwardedPart>; truncated: boolean }
	| { failure: 'messageTooLarge' | 'unreadable' }
> {
	if (job.rawSize > MAX_FORWARD_RAW_BYTES) return { failure: 'messageTooLarge' };
	const raw = await readSealedBlobBytesStreaming(
		ctx.storage,
		job.rawStorageId,
		getOptional('INSTANCE_SECRET')
	).catch(() => null);
	if (!raw) return { failure: 'unreadable' };
	const read = locateForwardedParts(raw);
	return {
		parts: new Map(read.parts.map((part) => [part.partIndex, part])),
		truncated: read.truncated,
	};
}

/**
 * Decode (only within the per-file limit), store, receipt and bind one copy;
 * the reason it stays owed, or null once bound. The decoded bytes live only
 * for this call.
 */
async function copyOn(
	ctx: Ctx,
	draftId: Id<'mailDrafts'>,
	key: string,
	file: { size: number; contentType: string; decode: () => Uint8Array }
): Promise<FulfilFailure | null> {
	if (file.size === 0) return 'unreadable';
	if (file.size > MAX_ATTACHMENT_BYTES) return 'tooLarge';
	const storageId = await ctx.storage.store(
		new Blob([file.decode() as BlobPart], { type: file.contentType })
	);
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
				size: part.size,
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
		const reason = part ? await copyOn(ctx, draftId, key, part) : 'unreadable';
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
			const reason = await copyOn(ctx, args.draftId, job.key, {
				size: bytes.byteLength,
				contentType: job.contentType,
				decode: () => bytes,
			});
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
