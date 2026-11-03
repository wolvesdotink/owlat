/**
 * Files on saved replies, and putting them on a Postbox draft.
 *
 * STORED ONCE. A reply owns its files through upload receipts bound to
 * `mailSnippets:<id>`. Inserting the reply puts the same blobs on the draft,
 * marked with `savedReplyId`: the draft borrows them and holds no receipt, so
 * removing the file from the draft, discarding it, sending it, the answered
 * draft purge, member erasure and workspace deletion all leave the bytes
 * alone. Only the reply deletes them: an edit that drops a file, the reply's
 * removal, the erasure of a personal reply's owner and workspace deletion.
 *
 * A file can therefore go while a draft still names it. Sending such a draft
 * is refused ({@link assertBorrowedFilesPresent} here, `bufferDraftAttachments`
 * at dispatch), because shipping the message without a file the person saw on
 * it is worse than asking them to remove the chip.
 *
 * Shared replies follow the same rules as their text: admins change them, and
 * every member who may insert one gets its files.
 */

import { v, type Infer } from 'convex/values';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import { getOrThrow, throwForbidden, throwInvalidInput, throwInvalidState } from '../_utils/errors';
import { consumeUpload, deleteOwnedUpload, storedFileSize } from '../storage/uploads';
import { deleteBlobQuietly } from '../lib/storageBlobs';
import type {
	SavedReplyAttachment,
	mailDraftAttachmentValidator,
} from '../lib/validators/mailContent';
import { postboxMutation } from './_helpers';
import { requireMailboxAccess } from './permissions';
import { assertStateIs } from './draftLifecycle/reducers';
import { humanEdit } from './draftProvenance';
import { canUseSavedReply, loadSavedReplyScope } from './savedReplyRules';

type DraftAttachment = Infer<typeof mailDraftAttachmentValidator>;

const RECEIPTS_PER_REPLY = 50;

/** The receipt key under which a saved reply owns its files. */
export function savedReplyUploadKey(replyId: Id<'mailSnippets'>): string {
	return `mailSnippets:${replyId}`;
}

/** The files a create or update names: kept ones by id, new ones as fresh uploads. */
export const savedReplyAttachmentArgs = v.array(
	v.object({ storageId: v.id('_storage'), filename: v.string(), contentType: v.string() })
);

/**
 * Make the reply carry exactly `next`. A file it already has stays as it is;
 * a new one has to be the caller's unclaimed upload and is bound to the reply;
 * a file it had that `next` leaves out is deleted. The composer's limits hold
 * here too, since every file goes into a draft whole. Returns the list to
 * store (undefined for none).
 */
export async function setSavedReplyAttachments(
	ctx: MutationCtx,
	session: MutationSessionContext,
	replyId: Id<'mailSnippets'>,
	current: readonly SavedReplyAttachment[],
	next: Infer<typeof savedReplyAttachmentArgs>
): Promise<SavedReplyAttachment[] | undefined> {
	const unique = [...new Map(next.map((file) => [file.storageId, file])).values()];
	if (unique.length > ATTACHMENT_COMPOSE_LIMITS.maxCount) throwInvalidInput('Too many attachments');
	const key = savedReplyUploadKey(replyId);
	const kept: SavedReplyAttachment[] = [];
	let totalBytes = 0;
	for (const file of unique) {
		const existing = current.find((held) => held.storageId === file.storageId);
		if (!existing) await consumeUpload(ctx, file.storageId, session, key);
		const size = existing?.size ?? (await storedFileSize(ctx, file.storageId));
		if (size > MAX_ATTACHMENT_BYTES) {
			throwInvalidInput('Attachment size exceeds the allowed limit');
		}
		totalBytes += size;
		kept.push({
			storageId: file.storageId,
			filename: existing?.filename ?? (file.filename.trim().slice(0, 255) || 'attachment'),
			contentType: existing?.contentType ?? file.contentType.slice(0, 255),
			size,
		});
	}
	if (totalBytes > ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) {
		throwInvalidInput('Attachments exceed the total size limit');
	}
	for (const held of current) {
		if (!kept.some((file) => file.storageId === held.storageId)) {
			await deleteOwnedUpload(ctx, held.storageId, key);
		}
	}
	return kept.length > 0 ? kept : undefined;
}

/**
 * Delete a saved reply with the files it owns. Every path that deletes a
 * reply row goes through here, so no file outlives its reply. Returns how
 * many rows it wrote, for the erasure's budget.
 */
export async function deleteSavedReplyWithFiles(
	ctx: MutationCtx,
	row: Doc<'mailSnippets'>
): Promise<number> {
	// More than a reply can hold: an edit deletes the receipt of a file it drops.
	const receipts = await ctx.db
		.query('storageUploads')
		.withIndex('by_resource', (q) => q.eq('resourceKey', savedReplyUploadKey(row._id)))
		.take(RECEIPTS_PER_REPLY);
	for (const receipt of receipts) {
		// Only a bound receipt is deletion authority for its blob. A blob that
		// is already gone must not stop an erasure that is otherwise complete.
		if (receipt.storageId && receipt.status === 'bound') {
			await deleteBlobQuietly(ctx.storage, receipt.storageId, '[saved reply] delete', {
				replyId: row._id,
			});
		}
		await ctx.db.delete(receipt._id);
	}
	await ctx.db.delete(row._id);
	return receipts.length + 1;
}

/**
 * Refuse to send a draft while a file it borrowed from a saved reply is gone:
 * the reply dropped it, or was deleted, after it was inserted.
 */
export async function assertBorrowedFilesPresent(
	ctx: Pick<QueryCtx, 'db'>,
	draft: Pick<Doc<'mailDrafts'>, 'attachments'>
): Promise<void> {
	for (const attachment of draft.attachments) {
		if (!attachment.savedReplyId) continue;
		if (await ctx.db.system.get(attachment.storageId)) continue;
		throwInvalidState(
			`"${attachment.filename}" was removed from its saved reply. Remove it from the draft to send.`
		);
	}
}

/**
 * Put a saved reply's files on the draft it was inserted into. The caller
 * must be able to write the draft and to insert the reply there. A file the
 * draft already has is skipped, so inserting a reply twice attaches its
 * files once. Returns the draft's attachments.
 */
// authz: the draft's mailbox access (requireMailboxAccess) and canUseSavedReply for the reply.
export const attachToDraft = postboxMutation({
	args: { draftId: v.id('mailDrafts'), replyId: v.id('mailSnippets') },
	handler: async (ctx, args, session): Promise<DraftAttachment[]> => {
		const draft = await getOrThrow(ctx, args.draftId, 'Draft');
		const owned = await requireMailboxAccess(ctx, draft.mailboxId, 'member', session);
		if (!owned.ok) throwForbidden('Draft not accessible');
		assertStateIs(draft, 'draft');
		const reply = await getOrThrow(ctx, args.replyId, 'Saved reply');
		const scope = await loadSavedReplyScope(ctx, reply);
		if (!canUseSavedReply(scope, session, draft.mailboxId)) throwForbidden('Not accessible');

		const adding = (reply.attachments ?? []).filter(
			(file) => !draft.attachments.some((held) => held.storageId === file.storageId)
		);
		if (adding.length === 0) return draft.attachments;
		if (draft.attachments.length + adding.length > ATTACHMENT_COMPOSE_LIMITS.maxCount) {
			throwInvalidInput('Too many attachments');
		}
		const sizes = await Promise.all(
			[...draft.attachments, ...adding].map((file) => storedFileSize(ctx, file.storageId))
		);
		if (
			sizes.reduce((total, bytes) => total + bytes, 0) > ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes
		) {
			throwInvalidInput('Attachments exceed the total size limit');
		}
		const attachments: DraftAttachment[] = [
			...draft.attachments,
			...adding.map((file) => ({
				storageId: file.storageId,
				filename: file.filename,
				contentType: file.contentType,
				size: file.size,
				isInline: false,
				savedReplyId: reply._id,
			})),
		];
		await ctx.db.patch(args.draftId, { attachments, ...humanEdit(Date.now()) });
		return attachments;
	},
});
