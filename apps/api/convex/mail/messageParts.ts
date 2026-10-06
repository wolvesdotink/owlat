/**
 * Attachment leaves stored one blob per part (plan 3.5 / E6).
 *
 * The reader used to download the WHOLE raw `.eml` to hand the user one
 * attachment: opening a 200 KB PDF out of a 20 MB message moved 20 MB, and the
 * invite card did the same on every mount just to read a few KB of iCalendar.
 * The MX ingest action now cuts every attachment leaf out of the raw message
 * while it still holds the bytes ({@link stageMessageParts}), stores each as
 * its own sealed blob plus the first `text/calendar` leaf, and the delivery
 * mutation records them in one `mailMessageParts` row keyed by the raw blob
 * ({@link recordStoredParts}). `mail/mailbox/parts.ts` serves them.
 *
 * SAME WALKER AS THE CLIENT. The leaves come from
 * `@owlat/shared/mailMime.extractAttachments` / `extractFirstPartByType`, the
 * functions the web reader runs over the raw `.eml`, and {@link pickStoredPart}
 * is `extractAttachmentAt`'s selection over the stored list. So the part served
 * here is byte for byte the part the fallback would have extracted. The
 * calendar leaf is the one exception: it is stored as text, decoded from the
 * charset it declares and re-encoded as UTF-8, which is what its stored
 * content type says and what the fallback's `decodePartText` reads.
 *
 * KEYED BY THE RAW BLOB. IMAP COPY spreads one `rawStorageId` over several
 * rows, and the parts are a function of those bytes, so the copies share them
 * and they are freed exactly when the raw blob is: `deleteMessageRowAndBlobs`
 * calls {@link deleteMessagePartsForRaw} once no row references the raw blob.
 *
 * DERIVED, NEVER REQUIRED. No row (mail from before this, IMAP sync, imports)
 * means the reader extracts from the raw `.eml` as it always did.
 */

import type { Infer } from 'convex/values';
import {
	decodePartText,
	extractFirstPartByType,
	type ExtractedAttachment,
} from '@owlat/shared/mailMime';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { storeSealedBlob, type BlobStore } from '../lib/sealedBlob';
import { deleteBlobQuietly, type BlobStorage } from '../lib/storageBlobs';
import { logError } from '../lib/runtimeLog';
import type { mailMessageStoredPartsValidator } from '../schema/mailComposition';

/** What {@link stageMessageParts} stored, as `deliverToMailbox` receives it. */
export type StoredMessageParts = Infer<typeof mailMessageStoredPartsValidator>;

/**
 * Most leaves one message has cut out. Well above what a person sends
 * (`ATTACHMENT_COMPOSE_LIMITS.maxCount` is 10); a crafted message with more
 * gets no stored parts at all and keeps the raw-`.eml` path, rather than a
 * partial list the filename fallback could pick a wrong part out of.
 */
export const MAX_STORED_PARTS = 32;

/** The content type a leaf with no usable type is stored and served under. */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';

const LOG_TAG = '[message parts]';

/**
 * `extractAttachmentAt`'s selection, over the stored list: the leaf at
 * `partIndex` when its filename matches (or none was asked for), else the
 * first leaf with that filename, else the leaf at `partIndex` anyway.
 * Mirrored rather than shared because the client walks bytes and this walks
 * rows; `messageParts.test.ts` holds the two to the same answers.
 */
export function pickStoredPart<T extends { filename: string }>(
	parts: readonly T[],
	partIndex: string,
	filename?: string
): T | null {
	const idx = Number.parseInt(partIndex, 10);
	const inRange = Number.isInteger(idx) && idx >= 0 && idx < parts.length;
	if (inRange) {
		const byIdx = parts[idx]!;
		if (!filename || byIdx.filename === filename) return byIdx;
	}
	if (filename) {
		const byName = parts.find((part) => part.filename === filename);
		if (byName) return byName;
	}
	return inRange ? parts[idx]! : null;
}

/** Every blob one stored-parts record owns. */
export function partBlobIds(row: {
	parts: ReadonlyArray<{ storageId: Id<'_storage'> }>;
	calendarStorageId?: Id<'_storage'>;
}): Id<'_storage'>[] {
	const ids = row.parts.map((part) => part.storageId);
	if (row.calendarStorageId) ids.push(row.calendarStorageId);
	return ids;
}

/**
 * Cut a received message into stored parts, in the ingest action, while the
 * raw bytes are still in hand. `leaves` is the document-order attachment walk
 * the malware scan already made (`InboundScanResult.leaves`), so the message
 * is not walked twice.
 *
 * Stored one after another, before the delivery mutation: a handful of leaves
 * is the ordinary message. Best-effort: a failure drops whatever was stored
 * and returns `undefined`, and the message is delivered without stored parts
 * — the reader falls back to the raw `.eml`, as every message did before this.
 */
export async function stageMessageParts(
	ctx: { storage: BlobStore & BlobStorage },
	rawBinary: string,
	leaves: readonly ExtractedAttachment[]
): Promise<StoredMessageParts | undefined> {
	const written: Id<'_storage'>[] = [];
	const store = async (bytes: Uint8Array, contentType: string) => {
		const storageId = await storeSealedBlob(ctx.storage, bytes, contentType);
		written.push(storageId);
		return storageId;
	};
	try {
		const tooMany = leaves.length > MAX_STORED_PARTS;
		const parts: StoredMessageParts['parts'] = [];
		for (const leaf of tooMany ? [] : leaves) {
			const contentType = leaf.contentType || FALLBACK_CONTENT_TYPE;
			parts.push({
				filename: leaf.filename,
				contentType,
				size: leaf.bytes.byteLength,
				storageId: await store(leaf.bytes, contentType),
			});
		}
		const calendar = extractFirstPartByType(rawBinary, 'text/calendar');
		// Transcoded, not relabelled: an invite declaring iso-8859-1 or
		// windows-1252 would otherwise be read back as broken UTF-8 (#1299).
		const calendarStorageId = calendar
			? await store(
					new TextEncoder().encode(decodePartText(calendar)),
					'text/calendar; charset=utf-8'
				)
			: undefined;
		return {
			status: tooMany ? 'too_many_parts' : 'stored',
			parts,
			...(calendarStorageId ? { calendarStorageId } : {}),
		};
	} catch (err) {
		logError(`${LOG_TAG} staging failed, delivering without stored parts`, err);
		for (const storageId of written) {
			await deleteBlobQuietly(ctx.storage, storageId, LOG_TAG);
		}
		return undefined;
	}
}

/** Record the staged parts of a freshly inserted message's raw blob. */
export async function recordStoredParts(
	ctx: MutationCtx,
	rawStorageId: Id<'_storage'>,
	stored: StoredMessageParts
): Promise<void> {
	await ctx.db.insert('mailMessageParts', { rawStorageId, ...stored, createdAt: Date.now() });
}

/**
 * Drop the stored parts of a raw blob: the row and every blob it names. Called
 * when the raw blob itself is freed, and by the reseal that replaces it.
 */
export async function deleteMessagePartsForRaw(
	ctx: MutationCtx,
	rawStorageId: Id<'_storage'>
): Promise<void> {
	const rows = await ctx.db
		.query('mailMessageParts')
		.withIndex('by_raw_storage', (q) => q.eq('rawStorageId', rawStorageId))
		.take(8);
	for (const row of rows) {
		await ctx.db.delete(row._id);
		for (const storageId of partBlobIds(row)) {
			await deleteBlobQuietly(ctx.storage, storageId, LOG_TAG, { rawStorageId });
		}
	}
}
