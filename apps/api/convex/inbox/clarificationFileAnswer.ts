/**
 * File answers for the background clarification loops: the owner answers a
 * "which file?" / "I couldn't find it" question with a Files row, a Postbox
 * mail attachment, or a fresh upload.
 *
 * Shared by the two answer mutations (`inbox/clarification.ts` for the team
 * pipeline, `mail/ai/needsReplyClarify.ts` for the Postbox Reply Queue). The
 * file reference comes from the client, so every source is re-checked here
 * before it is stored on the answer: the row must exist and still hold bytes,
 * a mail attachment must sit in a mailbox the caller can read, and an upload
 * must be the caller's own unclaimed one.
 *
 * An upload is saved to Files as a contact-scoped `semanticFiles` row by
 * default (decision 5), through the same insert, upload receipt and processing
 * the Files page uses, so the next request for it finds it. The answer then
 * points at that row. With `keepCopy: false`, or when the caller may not add to
 * Files, the upload stays unclaimed and the answer keeps pointing at it; the
 * client attaches it to the reply itself.
 */

import type { Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { DEFAULT_FILE_POLICY, isFileTypeAccepted } from '@owlat/email-scanner';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { consumeUpload, storedFileSize } from '../storage/uploads';
import { insertSemanticFile } from '../semanticFiles';
import { requireMailboxAccess } from '../mail/permissions';
import type { MutationSessionContext } from '../lib/sessionOrganization';
import type { clarificationFileRefValidator } from '../lib/validators/clarification';

export type ClarificationFileRef = Infer<typeof clarificationFileRefValidator>;

export interface ResolvedFileAnswer {
	/** The reference stored on the answer (an upload saved to Files becomes a `semanticFile`). */
	ref: ClarificationFileRef;
	/** The Files row behind the answer, when there is one. */
	semanticFile?: Doc<'semanticFiles'>;
}

interface ResolveOptions {
	/** Keep an uploaded answer in Files (default true). */
	keepCopy?: boolean | undefined;
	/** An upload's type as the browser reported it; the stored content type wins. */
	mimeType?: string | undefined;
	/** Contact the saved copy is scoped to (the sender); org-general when absent. */
	contactId?: Id<'contacts'> | undefined;
	/** Postbox answers may name a mail attachment; team answers may not. */
	allowMailAttachment: boolean;
	/** Whether the caller may add to Files (the Files page requires an admin). */
	canSaveToFiles: boolean;
}

/**
 * Check a file answer and return what to store on the question. Throws a typed
 * invalid-input / forbidden error when the reference is unusable, so the owner
 * sees the problem instead of a draft that silently lacks the file.
 */
export async function resolveClarificationFile(
	ctx: MutationCtx,
	session: MutationSessionContext,
	file: ClarificationFileRef,
	options: ResolveOptions
): Promise<ResolvedFileAnswer> {
	if (file.source === 'semanticFile') {
		const id = ctx.db.normalizeId('semanticFiles', file.id);
		const row = id ? await ctx.db.get(id) : null;
		if (!row || !row.storageId) throwInvalidInput('That file is no longer available');
		return {
			ref: { source: 'semanticFile', id: row._id, filename: row.filename },
			semanticFile: row,
		};
	}

	if (file.source === 'mailAttachment') {
		if (!options.allowMailAttachment) {
			throwInvalidInput('Pick a file from Files or upload one');
		}
		const id = ctx.db.normalizeId('mailAttachments', file.id);
		const row = id ? await ctx.db.get(id) : null;
		if (!row) throwInvalidInput('That attachment is no longer available');
		const access = await requireMailboxAccess(ctx, row.mailboxId);
		if (!access.ok) throwForbidden('Attachment not accessible');
		return { ref: { source: 'mailAttachment', id: row._id, filename: row.filename } };
	}

	const storageId = ctx.db.system.normalizeId('_storage', file.id);
	if (!storageId) throwInvalidInput('Uploaded file not found');
	validateStringLength(file.filename, STRING_LIMITS.FILENAME, 'filename');
	await assertOwnUnclaimedUpload(ctx, session, storageId);
	if (options.keepCopy !== false && options.canSaveToFiles) {
		const row = await saveUploadToFiles(ctx, session, {
			storageId,
			filename: file.filename,
			mimeType: options.mimeType,
			contactId: options.contactId,
		});
		return {
			ref: { source: 'semanticFile', id: row._id, filename: row.filename },
			semanticFile: row,
		};
	}
	return { ref: { source: 'upload', id: storageId, filename: file.filename } };
}

/**
 * Save an uploaded answer to Files: the same type and size policy as the Files
 * page upload (`semanticFiles.create`), the shared insert, the upload receipt
 * bound to the new row, and the processing pass that makes it searchable.
 */
async function saveUploadToFiles(
	ctx: MutationCtx,
	session: MutationSessionContext,
	args: {
		storageId: Id<'_storage'>;
		filename: string;
		mimeType?: string | undefined;
		contactId?: Id<'contacts'> | undefined;
	}
): Promise<Doc<'semanticFiles'>> {
	const metadata = await ctx.db.system.get(args.storageId);
	const mimeType = metadata?.contentType ?? args.mimeType ?? 'application/octet-stream';
	validateStringLength(mimeType, STRING_LIMITS.MIME_TYPE, 'mimeType');
	if (!isFileTypeAccepted(args.filename, mimeType, DEFAULT_FILE_POLICY)) {
		throwInvalidInput(`File type not allowed: ${args.filename}`);
	}
	const fileSize = await storedFileSize(ctx, args.storageId);
	if (fileSize <= 0) throwInvalidInput('File size must be positive');
	if (fileSize > MAX_LIBRARY_FILE_BYTES) {
		throwInvalidInput(`File exceeds the ${MAX_LIBRARY_FILE_MB} MB upload limit`);
	}

	const fileId = await insertSemanticFile(ctx, {
		storageId: args.storageId,
		filename: args.filename,
		mimeType,
		fileSize,
		sourceType: 'upload',
		uploadedBy: session.userId,
		...(args.contactId ? { contactIds: [args.contactId] } : {}),
	});
	await consumeUpload(ctx, args.storageId, session, `semanticFiles:${fileId}`);
	await ctx.scheduler.runAfter(0, internal.semanticFileProcessing.processFile, { fileId });
	const row = await ctx.db.get(fileId);
	if (!row) throwInvalidInput('Uploaded file not found');
	return row;
}

/**
 * The same ownership test `consumeUpload` applies, without claiming the upload:
 * an answer that keeps no copy must still only name the caller's own upload.
 */
async function assertOwnUnclaimedUpload(
	ctx: MutationCtx,
	session: MutationSessionContext,
	storageId: Id<'_storage'>
): Promise<void> {
	const receipt = await ctx.db
		.query('storageUploads')
		.withIndex('by_storage', (q) => q.eq('storageId', storageId))
		.unique();
	if (
		!receipt ||
		receipt.status !== 'uploaded' ||
		receipt.userId !== session.userId ||
		receipt.organizationId !== session.activeOrganizationId ||
		(receipt.expiresAt ?? 0) <= Date.now()
	) {
		throwForbidden('File is not an unclaimed upload owned by this user');
	}
}

/**
 * The confident suggestion recorded on the inbound message when the owner
 * picked or uploaded a Files row, in the shape the draft step and the review
 * surface already read (`lib/validators/attachment.ts`).
 */
export function ownerPickSuggestion(
	file: Doc<'semanticFiles'> & { storageId: Id<'_storage'> },
	query: string
) {
	return {
		query,
		ambiguous: false,
		candidates: [
			{
				fileId: file._id,
				storageId: file.storageId,
				filename: file.filename,
				...(file.title ? { title: file.title } : {}),
				mimeType: file.mimeType,
				fileSize: file.fileSize,
				// The owner chose it; nothing ranks above that.
				score: 1,
			},
		],
	};
}
