/**
 * Attaching a file that already exists: a row in Files (`semanticFiles`) or an
 * attachment of a received email (`mailAttachments`), shared by every reply
 * that can carry one (the Team inbox reply in `inbox/replyAttachments.ts`, the
 * Postbox draft's `attachExisting`).
 *
 * Two halves, because they run in different places:
 *
 *  - {@link resolveReadableExistingAttachment} runs in the mutation. It checks
 *    the caller may read the file and says where its bytes are.
 *  - {@link readExistingAttachmentBytes} runs in an action (only actions can
 *    read blob bytes) and returns the plaintext.
 *
 * Callers COPY the bytes into a blob the reply owns instead of pointing at the
 * source blob. Pointing is not safe: the inbound retention sweep releases the
 * blobs of team-inbox captures in Files, deleting a Files row deletes its blob,
 * and a mail attachment has no blob of its own at all, only a sealed part cut
 * out of the raw message (or just the sealed raw message on older mail).
 *
 * Access: a Files row is readable by any organization member (the Files page
 * lists them all); a mail attachment only by someone with access to the
 * mailbox it arrived in, the same gate the Postbox reader's download uses.
 */

import { v, type Infer } from 'convex/values';
import { extractAttachmentAt } from '@owlat/shared/mailMime';
import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import type { MutationSessionContext } from './sessionOrganization';
import { readSealedBlobBytes, type BlobGet } from './sealedBlob';
import { requireMailboxAccess } from '../mail/permissions';
import { pickStoredPart } from '../mail/messageParts';
import { throwForbidden, throwInvalidState, throwNotFound } from '../_utils/errors';

export const existingAttachmentSourceValidator = v.union(
	v.literal('semanticFile'),
	v.literal('mailAttachment')
);
type ExistingAttachmentSource = Infer<typeof existingAttachmentSourceValidator>;

/** Where the plaintext of an existing file can be read from, in an action. */
export const existingAttachmentBytesValidator = v.union(
	// A Files blob, stored as plaintext.
	v.object({ kind: v.literal('blob'), storageId: v.id('_storage') }),
	// One attachment part cut out of a delivered message, sealed at rest.
	v.object({ kind: v.literal('sealedPart'), storageId: v.id('_storage') }),
	// No stored part: the sealed raw message and which leaf to cut out of it.
	v.object({
		kind: v.literal('rawEml'),
		rawStorageId: v.id('_storage'),
		partIndex: v.string(),
		filename: v.string(),
	})
);
type ExistingAttachmentBytes = Infer<typeof existingAttachmentBytesValidator>;

export interface ExistingAttachment {
	source: ExistingAttachmentSource;
	/** The normalized row id. */
	id: string;
	filename: string;
	contentType: string;
	/** Bytes, as recorded for the source. The copy re-measures what it read. */
	size: number;
	bytes: ExistingAttachmentBytes;
}

/**
 * The file `id` names, if the caller may read it. Throws not-found for an id
 * that does not parse or has no row, forbidden for a mailbox the caller cannot
 * open, and invalid-state for a Files row whose bytes were already released.
 */
export async function resolveReadableExistingAttachment(
	ctx: QueryCtx,
	args: { source: ExistingAttachmentSource; id: string },
	session: MutationSessionContext
): Promise<ExistingAttachment> {
	if (args.source === 'semanticFile') {
		const fileId = ctx.db.normalizeId('semanticFiles', args.id);
		const file = fileId ? await ctx.db.get(fileId) : null;
		if (!file) throwNotFound('File');
		if (!file.storageId) throwInvalidState('This file is no longer stored');
		const stored = await ctx.db.system.get(file.storageId);
		if (!stored) throwInvalidState('This file is no longer stored');
		return {
			source: 'semanticFile',
			id: file._id,
			filename: file.filename,
			contentType: file.mimeType,
			size: stored.size,
			bytes: { kind: 'blob', storageId: file.storageId },
		};
	}

	const attachmentId = ctx.db.normalizeId('mailAttachments', args.id);
	const attachment = attachmentId ? await ctx.db.get(attachmentId) : null;
	if (!attachment) throwNotFound('Attachment');
	const access = await requireMailboxAccess(ctx, attachment.mailboxId, 'member', session);
	if (!access.ok) throwForbidden('Attachment not accessible');
	const message = await ctx.db.get(attachment.messageId);
	if (!message || message.mailboxId !== attachment.mailboxId) throwNotFound('Attachment');

	const parts = await ctx.db
		.query('mailMessageParts')
		.withIndex('by_raw_storage', (q) => q.eq('rawStorageId', message.rawStorageId))
		.first();
	const part =
		parts?.status === 'stored'
			? pickStoredPart(parts.parts, attachment.partIndex, attachment.filename)
			: null;
	return {
		source: 'mailAttachment',
		id: attachment._id,
		filename: attachment.filename,
		contentType: attachment.contentType,
		size: attachment.size,
		bytes: part
			? { kind: 'sealedPart', storageId: part.storageId }
			: {
					kind: 'rawEml',
					rawStorageId: message.rawStorageId,
					partIndex: attachment.partIndex,
					filename: attachment.filename,
				},
	};
}

/** The plaintext of an existing file, or `null` when its bytes are gone. */
export async function readExistingAttachmentBytes(
	storage: BlobGet,
	bytes: ExistingAttachmentBytes
): Promise<Uint8Array | null> {
	switch (bytes.kind) {
		case 'blob': {
			const blob = await storage.get(bytes.storageId);
			return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
		}
		case 'sealedPart':
			return readSealedBlobBytes(storage, bytes.storageId);
		case 'rawEml': {
			const raw = await readSealedBlobBytes(storage, bytes.rawStorageId);
			if (!raw) return null;
			// One char per byte, so binary parts survive the MIME walk.
			const eml = new TextDecoder('latin1').decode(raw);
			return extractAttachmentAt(eml, bytes.partIndex, bytes.filename)?.bytes ?? null;
		}
	}
}
