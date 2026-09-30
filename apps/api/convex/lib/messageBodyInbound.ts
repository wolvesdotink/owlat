/**
 * Shape 1 of the message-body family (see `messageBody.ts`): the Team Inbox
 * `inboundMessages` body, and the ONE accessor every reader of it goes through.
 *
 * A part (text, HTML) is stored in exactly one of two places. Small mail keeps
 * both inline on the row, sealed with the text cipher, as it always has. When
 * the two together would crowd the 1 MiB document limit, the ingest action
 * moves the larger part — or both — into a sealed storage blob
 * (`inbox/bodyStorage.ts` decides, `lib/sealedBlob.storeSealedBlob` writes) and
 * the row keeps a bounded `bodyExcerpt` in place of whatever a reader would
 * have shown.
 *
 * WHY THE STORAGE ARGUMENT IS REQUIRED. Blob contents are readable from actions
 * only; a query or a mutation holding the same row can see the inline parts and
 * the excerpt and nothing else. Making every call site say which it is — pass
 * `ctx.storage` from an action, `null` from a query or mutation — is what stops
 * an action from quietly reading half a message, and `isComplete` is how a
 * query-side reader knows it got the excerpt rather than the body.
 *
 * Not a copy of Postbox's reader (`readMailMessageText`) because the contracts
 * differ: a `mailMessages` row keeps an inline SNIPPET beside its blob and its
 * readers only ever want text, while a Team Inbox row keeps nothing inline for a
 * stored part and its readers — the security scan, the phishing check, the
 * handling rules — need the HTML too. The blob cipher and the blob reader are
 * the same ones (`readSealedBlobBytes`).
 */

import type { Id } from '../_generated/dataModel';
import { openMessageBody } from './messageBody';
import { isSealedBytesAtRest } from './atRestBodies';
import { getOptional, getRequired } from './env';
import { readSealedBlobBytes, type BlobGet } from './sealedBlob';
import { deleteBlobQuietly, type BlobStorage } from './storageBlobs';

/** The body columns of an `inboundMessages` row. `null` is tolerated so a
 * projection that carries a part as `string | null` passes through unchanged. */
export interface InboundMessageBodyFields {
	textBody?: string | null;
	htmlBody?: string | null;
	textBodyStorageId?: Id<'_storage'> | null;
	htmlBodyStorageId?: Id<'_storage'> | null;
	bodyExcerpt?: string | null;
}

/** A decrypted body. Absent parts are `undefined`; a present one is returned
 * verbatim — this accessor never fabricates or strips content. */
export interface InboundMessageBody {
	text: string | undefined;
	html: string | undefined;
}

/** What one read of a row yielded. */
export interface InboundMessageBodyRead extends InboundMessageBody {
	/**
	 * Every part the message has is in `text` / `html`. False when a part lives
	 * in storage and this read could not fetch it — a query or mutation, or a
	 * blob that is gone — and then `excerpt` is the only stand-in there is.
	 */
	isComplete: boolean;
	/** The decrypted `bodyExcerpt`, when the row has one. */
	excerpt: string | undefined;
}

/** Read the RAW body columns of a row, without decrypting or fetching. For
 * shape checks only; use {@link openInboundMessageBody} for content. */
export function inboundMessageBody(row: InboundMessageBodyFields): InboundMessageBody {
	return { text: row.textBody ?? undefined, html: row.htmlBody ?? undefined };
}

async function openOptional(stored: string | null | undefined): Promise<string | undefined> {
	return stored == null ? undefined : openMessageBody(stored);
}

const decoder = new TextDecoder();

/** One part: inline, fetched from its blob, or missing from this read. */
async function openPart(
	inline: string | null | undefined,
	storageId: Id<'_storage'> | null | undefined,
	storage: BlobGet | null
): Promise<{ value: string | undefined; isMissing: boolean }> {
	if (inline != null) return { value: await openMessageBody(inline), isMissing: false };
	if (storageId == null) return { value: undefined, isMissing: false };
	if (storage === null) return { value: undefined, isMissing: true };
	const bytes = await readSealedBlobBytes(storage, storageId);
	if (bytes === null) return { value: undefined, isMissing: true };
	// Without the key a sealed blob comes back as its ciphertext. Fail exactly
	// as the inline branch does (`openMessageBody` requires the secret) rather
	// than decode it into text a model or a reader would take for the body.
	if (getOptional('INSTANCE_SECRET') === undefined && isSealedBytesAtRest(bytes)) {
		getRequired('INSTANCE_SECRET');
	}
	return { value: decoder.decode(bytes), isMissing: false };
}

/**
 * Read AND UNSEAL an `inboundMessages` body.
 *
 * `storage` is an action's `ctx.storage` (the full body, blobs fetched) or
 * `null` from a query or mutation — or from an action that only wants the
 * bounded view, like the agent's thread history — for the inline parts plus
 * the excerpt. Legacy plaintext columns and unsealed blobs pass through
 * unchanged.
 */
export async function openInboundMessageBody(
	row: InboundMessageBodyFields,
	storage: BlobGet | null
): Promise<InboundMessageBodyRead> {
	const [text, html, excerpt] = await Promise.all([
		openPart(row.textBody, row.textBodyStorageId, storage),
		openPart(row.htmlBody, row.htmlBodyStorageId, storage),
		openOptional(row.bodyExcerpt),
	]);
	return {
		text: text.value,
		html: html.value,
		isComplete: !text.isMissing && !html.isMissing,
		excerpt,
	};
}

/**
 * Open the body columns of a WHOLE row, for a read that hands the row itself
 * to a client — the thread view, the review queue, the quarantine and failed
 * lists render straight off the row they were given. Sealing is an at-rest
 * property, so a row leaving the access-checked read boundary carries
 * plaintext: the inline parts and the excerpt. A stored part stays a storage
 * id; the thread view fetches it through `inbox/bodyText.getInboundMessageText`.
 *
 * Only keys the row actually HAS are rewritten, so an absent column never
 * starts travelling as a present `undefined`.
 */
export async function openInboundMessageRow<T extends InboundMessageBodyFields>(
	row: T
): Promise<T> {
	if (row.textBody == null && row.htmlBody == null && row.bodyExcerpt == null) return row;
	const [text, html, excerpt] = await Promise.all([
		openOptional(row.textBody),
		openOptional(row.htmlBody),
		openOptional(row.bodyExcerpt),
	]);
	return {
		...row,
		...(row.textBody != null ? { textBody: text } : {}),
		...(row.htmlBody != null ? { htmlBody: html } : {}),
		...(row.bodyExcerpt != null ? { bodyExcerpt: excerpt } : {}),
	};
}

/** {@link openInboundMessageRow} over a page of rows, preserving order. */
export async function openInboundMessageRows<T extends InboundMessageBodyFields>(
	rows: T[]
): Promise<T[]> {
	return Promise.all(rows.map((row) => openInboundMessageRow(row)));
}

/** The body blobs a row owns. The raw `.eml` is not one of them. */
export function inboundBodyBlobIds(row: InboundMessageBodyFields): Id<'_storage'>[] {
	const ids: Id<'_storage'>[] = [];
	if (row.textBodyStorageId) ids.push(row.textBodyStorageId);
	if (row.htmlBodyStorageId) ids.push(row.htmlBodyStorageId);
	return ids;
}

/**
 * Delete a row's body blobs, for every path that deletes the row: contact
 * erasure, workspace deletion, the dev reset. Never throws — the same
 * `deleteBlobQuietly` policy those paths already apply to the raw `.eml`,
 * because nothing walks storage looking for blobs whose row is gone.
 */
export async function deleteInboundBodyBlobs(
	storage: BlobStorage,
	row: InboundMessageBodyFields & { _id: Id<'inboundMessages'> },
	logTag: string
): Promise<void> {
	for (const storageId of inboundBodyBlobIds(row)) {
		await deleteBlobQuietly(storage, storageId, `${logTag} body`, { rowId: row._id });
	}
}
