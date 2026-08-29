/**
 * The `mailAttachments` junction — the indexable mirror of the (unindexable)
 * `mailMessages.attachments` array.
 *
 * Convex cannot index inside an array, so `filename:` could only ever be a
 * post-filter over one arrival-ordered page and there was no way to browse a
 * mailbox's files at all. Every path that writes a `mailMessages` row calls
 * `indexMessageAttachments` here, and every path that deletes one calls
 * `removeMessageAttachments`, so the junction is a function of the message
 * table rather than a second source of truth.
 *
 * Pure helpers live at the top (`isInlineAttachment`, `attachmentKind`) so the
 * facet vocabulary is shared by the write path, the read query and the web
 * Files view without any of them re-deriving it.
 */

import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';

/** One attachment's metadata, as it sits on a `mailMessages` row. */
export interface IndexableAttachment {
	filename: string;
	contentType: string;
	size: number;
	contentId?: string;
	partIndex: string;
}

/**
 * Inline parts (a `Content-ID` referenced by the HTML body — signature logos,
 * tracking pixels, quoted-image chrome) are NOT files anybody went looking for.
 * They are excluded from the index so the Files view is the documents someone
 * actually sent, not a wall of `image001.png`.
 */
export function isInlineAttachment(att: IndexableAttachment): boolean {
	return Boolean(att.contentId);
}

/**
 * Coarse type facet for the Files view. Deliberately a handful of buckets: the
 * facet is "what kind of thing is this", and a MIME-type-per-row facet list is
 * a taxonomy, not a filter.
 */
export type AttachmentKind = 'pdf' | 'image' | 'document' | 'archive' | 'other';

const DOCUMENT_TYPES = new Set([
	'text/plain',
	'text/csv',
	'text/html',
	'text/markdown',
	'application/msword',
	'application/rtf',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/vnd.ms-powerpoint',
	'application/vnd.openxmlformats-officedocument.presentationml.presentation',
	'application/vnd.oasis.opendocument.text',
	'application/vnd.oasis.opendocument.spreadsheet',
]);

const ARCHIVE_TYPES = new Set([
	'application/zip',
	'application/x-zip-compressed',
	'application/gzip',
	'application/x-tar',
	'application/x-7z-compressed',
	'application/vnd.rar',
	'application/x-rar-compressed',
]);

export function attachmentKind(contentType: string): AttachmentKind {
	const type = contentType.toLowerCase().split(';')[0]?.trim() ?? '';
	if (type === 'application/pdf') return 'pdf';
	if (type.startsWith('image/')) return 'image';
	if (DOCUMENT_TYPES.has(type)) return 'document';
	if (ARCHIVE_TYPES.has(type)) return 'archive';
	return 'other';
}

/**
 * Write the junction rows for one message. Idempotent: an existing row set for
 * the message is left alone, so the backfill can re-walk a mailbox that has
 * already been partly indexed without doubling every file.
 *
 * Returns how many rows were written (0 for a message with no non-inline
 * attachments, and 0 for one that was already indexed).
 */
export async function indexMessageAttachments(
	ctx: MutationCtx,
	message: {
		_id: Id<'mailMessages'>;
		mailboxId: Id<'mailboxes'>;
		folderId: Id<'mailFolders'>;
		fromAddress: string;
		receivedAt: number;
		attachments: IndexableAttachment[];
	}
): Promise<number> {
	const indexable = message.attachments.filter((att) => !isInlineAttachment(att));
	if (indexable.length === 0) return 0;

	const existing = await ctx.db
		.query('mailAttachments')
		.withIndex('by_message', (q) => q.eq('messageId', message._id))
		.first();
	if (existing) return 0;

	for (const att of indexable) {
		await ctx.db.insert('mailAttachments', {
			mailboxId: message.mailboxId,
			messageId: message._id,
			filename: att.filename,
			contentType: att.contentType,
			size: att.size,
			receivedAt: message.receivedAt,
			fromAddress: message.fromAddress.toLowerCase(),
			folderId: message.folderId,
			partIndex: att.partIndex,
		});
	}
	return indexable.length;
}

/**
 * Per-call ceiling on the teardown. A single message cannot realistically carry
 * more parts than this, and the bound keeps an adversarial row from blowing the
 * caller's write budget mid-expunge.
 */
const ATTACHMENT_TEARDOWN_CAP = 256;

/**
 * Drop one message's junction rows. Called from every `mailMessages` delete
 * (purge + IMAP EXPUNGE) — a dangling row would list a file whose message is
 * gone, and the Files view would 404 on open.
 */
export async function removeMessageAttachments(
	ctx: MutationCtx,
	messageId: Id<'mailMessages'>
): Promise<void> {
	const rows = await ctx.db
		.query('mailAttachments')
		.withIndex('by_message', (q) => q.eq('messageId', messageId))
		.take(ATTACHMENT_TEARDOWN_CAP);
	for (const row of rows) await ctx.db.delete(row._id);
}

/** Narrow a message doc down to what `indexMessageAttachments` needs. */
export function indexableFromMessage(message: Doc<'mailMessages'>) {
	return {
		_id: message._id,
		mailboxId: message.mailboxId,
		folderId: message.folderId,
		fromAddress: message.fromAddress,
		receivedAt: message.receivedAt,
		attachments: message.attachments,
	};
}
