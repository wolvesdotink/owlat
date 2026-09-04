/**
 * Per-message reseal of a `mailMessages` row's storage blobs (raw `.eml` + body
 * blobs) at rest — the production half of Sealed Mail E8b.
 *
 * A mutation cannot read or re-store a blob's bytes (blob contents are
 * action-only), so a write path that lands a worker-uploaded PLAINTEXT blob
 * seals it out-of-band through the scheduled {@link resealMessageBlobs} action
 * (`runAfter(0)`, idempotent):
 *   - `mail.imap.append.appendMessage` (IMAP APPEND uploads the raw `.eml`
 *     straight to storage) schedules the reseal after inserting the row.
 *   - `mail.external.delivery.ingestExternalMessage` (external IMAP sync) needs
 *     none: its sole caller `ingestExternalRaw` is an ACTION that seals the raw
 *     `.eml` (`storeSealedBlob`) and the body blobs (`splitBodyForStorage` →
 *     `storeSealedBlob`) before the mutation runs, so nothing lands plaintext.
 * Between the plaintext write and the scheduled reseal, the blob reads/serves
 * correctly through the mixed-tolerance accessors + `/sealed-blob` proxy.
 *
 * Because Convex storage is immutable per id, sealing a blob reads it, stores
 * the sealed copy under a new id, repoints EVERY row referencing the old blob
 * (IMAP COPY shares one blob across rows — see {@link repointResealedBlobs}),
 * then deletes the old plaintext blob. The one-shot back-fill
 * (`migrations/0035_seal_bodies_at_rest`) drives the same {@link resealRowBlobs}
 * step over every existing row.
 */

import { v } from 'convex/values';
import {
	internalAction,
	internalMutation,
	internalQuery,
	type ActionCtx,
} from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { resealStoredBlob } from '../lib/sealedBlob';

/**
 * Repoint EVERY row that references an old plaintext blob at its sealed copy,
 * then delete the old blob — atomically, in one mutation transaction, per column.
 *
 * SHARING-AWARE (the crux): IMAP COPY (`mail/imap/move.ts` copyMessages) shares a
 * storage blob across rows — the copy is a new `mailMessages` row spreading the
 * SAME `rawStorageId`/`textBodyStorageId`/`htmlBodyStorageId`. If we repointed
 * only the row we resealed and deleted the old blob, every sibling copy would be
 * left pointing at a deleted id — unreadable forever (`readSealedBlobBytes` →
 * `null`, `/sealed-blob` 404, IMAP `FETCH RFC822` empty). So for each column we
 * look up ALL rows referencing the old id (via the `by_*_storage` index) and
 * repoint them to the new sealed id BEFORE deleting the old blob. The primary
 * resealed row is among them (it still references the old id at call time).
 *
 * Doing repoint-and-delete in one mutation closes the orphan window: an interrupt
 * cannot leave a row pointing at the sealed copy while the old plaintext blob
 * lingers (a later re-run would then skip it, since its pointer is already
 * sealed). Mutations may delete storage (`dropBlob` in `ingestExternalMessage`
 * does too). Each `*StorageId` arg is the NEW sealed id; the paired
 * `old*StorageId` is the shared plaintext blob to drop.
 */
export const repointResealedBlobs = internalMutation({
	args: {
		rawStorageId: v.optional(v.id('_storage')),
		oldRawStorageId: v.optional(v.id('_storage')),
		textBodyStorageId: v.optional(v.id('_storage')),
		oldTextBodyStorageId: v.optional(v.id('_storage')),
		htmlBodyStorageId: v.optional(v.id('_storage')),
		oldHtmlBodyStorageId: v.optional(v.id('_storage')),
	},
	handler: async (ctx, args) => {
		const maxSharedBlobReferences = 1_000;
		if (args.rawStorageId && args.oldRawStorageId) {
			const newId = args.rawStorageId;
			const oldId = args.oldRawStorageId;
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_raw_storage', (q) => q.eq('rawStorageId', oldId))
				.take(maxSharedBlobReferences + 1);
			if (rows.length > maxSharedBlobReferences) {
				throw new Error('raw blob has too many shared references to migrate atomically');
			}
			for (const r of rows) await ctx.db.patch(r._id, { rawStorageId: newId });
			await ctx.storage.delete(oldId);
		}
		if (args.textBodyStorageId && args.oldTextBodyStorageId) {
			const newId = args.textBodyStorageId;
			const oldId = args.oldTextBodyStorageId;
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_text_body_storage', (q) => q.eq('textBodyStorageId', oldId))
				.take(maxSharedBlobReferences + 1);
			if (rows.length > maxSharedBlobReferences) {
				throw new Error('text body blob has too many shared references to migrate atomically');
			}
			for (const r of rows) await ctx.db.patch(r._id, { textBodyStorageId: newId });
			await ctx.storage.delete(oldId);
		}
		if (args.htmlBodyStorageId && args.oldHtmlBodyStorageId) {
			const newId = args.htmlBodyStorageId;
			const oldId = args.oldHtmlBodyStorageId;
			const rows = await ctx.db
				.query('mailMessages')
				.withIndex('by_html_body_storage', (q) => q.eq('htmlBodyStorageId', oldId))
				.take(maxSharedBlobReferences + 1);
			if (rows.length > maxSharedBlobReferences) {
				throw new Error('HTML body blob has too many shared references to migrate atomically');
			}
			for (const r of rows) await ctx.db.patch(r._id, { htmlBodyStorageId: newId });
			await ctx.storage.delete(oldId);
		}
	},
});

/** The storage-blob ids of one mailMessages row (raw `.eml` required, body blobs
 * optional). Shared by the back-fill page walker and the per-message reseal action. */
export interface MessageBlobIds {
	id: Id<'mailMessages'>;
	rawStorageId: Id<'_storage'>;
	textBodyStorageId?: Id<'_storage'>;
	htmlBodyStorageId?: Id<'_storage'>;
}

/**
 * Seal ONE message's storage blobs and repoint+delete atomically. Reseals the
 * raw `.eml` and both body blobs (each idempotent — an already-sealed blob
 * reseals to `null`), then, if anything changed, swaps the row's pointers and
 * drops the old plaintext originals in a single mutation. Returns `true` when a
 * blob was sealed. Shared by the back-fill page walker and the per-message
 * reseal scheduled after a plaintext-blob write path.
 */
export async function resealRowBlobs(ctx: ActionCtx, row: MessageBlobIds): Promise<boolean> {
	const newRaw = await resealStoredBlob(ctx.storage, row.rawStorageId);
	const newText = row.textBodyStorageId
		? await resealStoredBlob(ctx.storage, row.textBodyStorageId)
		: null;
	const newHtml = row.htmlBodyStorageId
		? await resealStoredBlob(ctx.storage, row.htmlBodyStorageId)
		: null;
	if (!newRaw && !newText && !newHtml) return false;
	// Repoint EVERY row sharing each old blob AND drop the old plaintext blobs in
	// ONE mutation, so the old-blob delete is transactional with the pointer swap
	// across all sibling copies. An interrupt before this call leaves the rows on
	// the still-readable plaintext original (mixed tolerance) and a re-run reseals;
	// an interrupt cannot orphan a plaintext blob behind an already-sealed pointer,
	// nor a sibling copy behind a deleted blob, because all-or-nothing per column.
	await ctx.runMutation(internal.mail.blobReseal.repointResealedBlobs, {
		rawStorageId: newRaw ?? undefined,
		oldRawStorageId: newRaw ? row.rawStorageId : undefined,
		textBodyStorageId: newText ?? undefined,
		oldTextBodyStorageId: newText && row.textBodyStorageId ? row.textBodyStorageId : undefined,
		htmlBodyStorageId: newHtml ?? undefined,
		oldHtmlBodyStorageId: newHtml && row.htmlBodyStorageId ? row.htmlBodyStorageId : undefined,
	});
	return true;
}

/** The storage-blob ids of ONE mailMessages row (per-message reseal). */
export const mailMessageBlobIdsById = internalQuery({
	args: { id: v.id('mailMessages') },
	handler: async (ctx, { id }): Promise<MessageBlobIds | null> => {
		const m = await ctx.db.get(id);
		if (!m) return null;
		return {
			id: m._id,
			rawStorageId: m.rawStorageId,
			textBodyStorageId: m.textBodyStorageId,
			htmlBodyStorageId: m.htmlBodyStorageId,
		};
	},
});

/**
 * Seal ONE message's storage blobs at rest. Scheduled (`runAfter(0)`) from IMAP
 * APPEND (`mail.imap.append.appendMessage`), which uploads the raw `.eml` straight to
 * storage as plaintext — a mutation cannot read/re-store a blob's contents, so
 * the staged plaintext blob must be resealed out-of-band. (External IMAP sync
 * already seals at write via the `ingestExternalRaw` action, so it needs no
 * scheduled reseal.) Idempotent: a re-run over an already-sealed blob is a no-op,
 * so double-scheduling or a retry never corrupts the row.
 */
export const resealMessageBlobs = internalAction({
	args: { id: v.id('mailMessages') },
	handler: async (ctx, { id }): Promise<void> => {
		const row = await ctx.runQuery(internal.mail.blobReseal.mailMessageBlobIdsById, { id });
		if (!row) return;
		await resealRowBlobs(ctx, row);
	},
});
