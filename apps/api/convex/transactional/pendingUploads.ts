/**
 * Pending ownership of attachment bytes the transactional API stores before
 * its intake has decided.
 *
 * `ctx.storage.store` is action-only, so the HTTP shell (`transactional/api.ts`)
 * writes the bytes BEFORE the dispatch mutation runs, and no single transaction
 * can cover both. Each stored blob therefore gets a `transactionalPendingUploads`
 * row at once, and exactly one of three things ends it:
 *
 *   - CLAIM: the dispatch mutation deletes the row in the transaction that
 *     inserts the Send. The Send's `attachmentStorageIds` own the blob from
 *     then on, and the Send lifecycle's `attachment_cleanup` frees it.
 *   - RELEASE: the shell refuses (an invalid attachment, a storage failure, a
 *     dispatch rejection or a thrown dispatch) and deletes every blob whose row
 *     is still here. A row that is gone was claimed, so an ambiguous dispatch
 *     outcome can never cost a queued Send its attachment.
 *   - EXPIRY: the request died between the two (a timeout, a redeploy, a
 *     release that itself failed); the sweep deletes the blob once the row
 *     expires. A claim that finds its row gone refuses the whole dispatch, so a
 *     Send never names bytes the sweep may already have freed.
 *
 * Release and expiry end a row only once its blob is confirmed gone (deleted,
 * or already absent). A storage error keeps the row, so a later sweep retries
 * the deletion instead of the blob losing its last owner (`freePendingBlob`).
 *
 * See docs/adr/0021-transactional-send-intake-module.md (amendment 2026-10-01).
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { ActionCtx, MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { deleteBlobQuietly } from '../lib/storageBlobs';
import { logError } from '../lib/runtimeLog';

/**
 * How long an unclaimed upload waits for its request. Longer than any request
 * can run, so the sweep only ever finds bytes whose request is over; a claim
 * past it fails closed either way.
 */
export const PENDING_UPLOAD_TTL_MS = 60 * 60 * 1000;

const SWEEP_BATCH = 100;

/** Delay before the first retry of a failed blob deletion; each failure doubles it. */
export const DELETE_RETRY_BASE_MS = 15 * 60 * 1000;

/**
 * Failed deletions after which a row gives up on its blob. The retries span
 * about 32 hours (15 minutes doubling to 16 hours), which outlasts a storage
 * outage; a blob that still cannot be deleted is logged as orphaned and its row
 * dropped, so the table and the sweep do not carry it for ever.
 */
export const MAX_DELETE_ATTEMPTS = 8;

async function findPending(ctx: MutationCtx, storageId: Id<'_storage'>) {
	return await ctx.db
		.query('transactionalPendingUploads')
		.withIndex('by_storage', (q) => q.eq('storageId', storageId))
		.unique();
}

type FreeOutcome = 'freed' | 'retrying' | 'abandoned';

/**
 * Delete a pending row's blob and end the row, but only once the blob is
 * confirmed gone: deleted now, or already absent (a deletion that committed in
 * an earlier attempt, a manual purge). Any storage error keeps the row: it
 * counts the failure, becomes unclaimable and moves its expiry out by the
 * backoff, which also takes it out of the sweep's current window so the rest of
 * the batch and the next batches still run. Never throws, so one blob cannot
 * abort a release or a sweep.
 */
async function freePendingBlob(
	ctx: MutationCtx,
	pending: Doc<'transactionalPendingUploads'>,
	logTag: string
): Promise<FreeOutcome> {
	try {
		if (await ctx.db.system.get(pending.storageId)) {
			await ctx.storage.delete(pending.storageId);
		}
	} catch (err) {
		const attempts = (pending.deleteAttempts ?? 0) + 1;
		const context = { storageId: pending.storageId, attempts, err };
		if (attempts >= MAX_DELETE_ATTEMPTS) {
			logError(`${logTag} blob delete failed; giving up and leaving the blob orphaned`, context);
			await ctx.db.delete(pending._id);
			return 'abandoned';
		}
		const retryInMs = DELETE_RETRY_BASE_MS * 2 ** (attempts - 1);
		logError(`${logTag} blob delete failed; kept for the sweep to retry`, {
			...context,
			retryInMs,
		});
		await ctx.db.patch(pending._id, {
			deleteAttempts: attempts,
			expiresAt: Date.now() + retryInMs,
		});
		return 'retrying';
	}
	await ctx.db.delete(pending._id);
	return 'freed';
}

/** Record a blob the shell just stored, before anything else can fail. */
export const register = internalMutation({
	args: { storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		await ctx.db.insert('transactionalPendingUploads', {
			storageId: args.storageId,
			expiresAt: Date.now() + PENDING_UPLOAD_TTL_MS,
		});
	},
});

/**
 * Delete the blobs that are still pending. One a Send claimed has no row any
 * more and is left alone, which is what makes this safe after a dispatch whose
 * outcome the shell never saw. Returns how many blobs were confirmed gone; one
 * whose deletion failed stays pending for the sweep.
 */
export const release = internalMutation({
	args: { storageIds: v.array(v.id('_storage')) },
	handler: async (ctx, args): Promise<number> => {
		let released = 0;
		for (const storageId of args.storageIds) {
			const pending = await findPending(ctx, storageId);
			if (!pending) continue;
			const outcome = await freePendingBlob(ctx, pending, '[transactional] release upload');
			if (outcome === 'freed') released++;
		}
		return released;
	},
});

/**
 * Hand the uploads to the Send being inserted in this transaction. Throws when
 * one is no longer pending (released or expired, including a release or sweep
 * whose deletion failed and is waiting to retry), which rolls the insert back.
 */
export async function claimPendingUploads(
	ctx: MutationCtx,
	storageIds: readonly string[]
): Promise<void> {
	for (const storageId of storageIds) {
		const pending = await findPending(ctx, storageId as Id<'_storage'>);
		if (!pending || pending.deleteAttempts !== undefined) {
			throw new Error(
				`Attachment upload ${storageId} is no longer pending; the send was not queued`
			);
		}
		await ctx.db.delete(pending._id);
	}
}

/** Free the bytes of requests that never finished. */
export const sweepExpired = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query('transactionalPendingUploads')
			.withIndex('by_expiry', (q) => q.lte('expiresAt', Date.now()))
			.take(SWEEP_BATCH);
		for (const pending of expired) {
			await freePendingBlob(ctx, pending, '[transactional] expired upload');
		}
		if (expired.length === SWEEP_BATCH) {
			await ctx.scheduler.runAfter(0, internal.transactional.pendingUploads.sweepExpired, {});
		}
	},
});

/** A blob the shell stored in this request, and whether its row was written. */
export interface StoredUpload {
	storageId: Id<'_storage'>;
	registered: boolean;
}

/**
 * Undo this request's uploads after a refusal. Never throws: the response the
 * caller is about to return matters more, and whatever this cannot delete the
 * expiry sweep still owns. A blob whose row was never written cannot be named
 * by any Send (the dispatch that could claim it never ran), so it goes directly.
 */
export async function discardStoredUploads(
	ctx: Pick<ActionCtx, 'storage' | 'runMutation'>,
	stored: readonly StoredUpload[]
): Promise<void> {
	const registered = stored.filter((upload) => upload.registered).map((u) => u.storageId);
	if (registered.length > 0) {
		try {
			await ctx.runMutation(internal.transactional.pendingUploads.release, {
				storageIds: registered,
			});
		} catch (err) {
			logError('[transactional] releasing attachment uploads failed; left to expiry', {
				count: registered.length,
				err,
			});
		}
	}
	for (const upload of stored) {
		if (!upload.registered) {
			await deleteBlobQuietly(ctx.storage, upload.storageId, '[transactional] unregistered upload');
		}
	}
}
