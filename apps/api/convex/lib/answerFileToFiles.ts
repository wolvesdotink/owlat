/**
 * Keeping an uploaded file answer in Files (decision 5 of the Answer mode
 * plan): the one rule set shared by every path that does it, the Answer mode
 * ask card (mail/ai/composeDraftContext.ts) and the two background
 * clarification answers (inbox/clarificationFileAnswer.ts).
 *
 * - Adding to Files is an admin action on the Files page (`semanticFiles.create`
 *   is an `adminMutation`), so it is here too: a member's upload still goes on
 *   the reply, it just is not kept.
 * - A copy is only kept for a known contact. The row is linked to that contact,
 *   the scope the automatic file search retrieves under, so the file comes up
 *   the next time this person asks and never for somebody else. With no
 *   contact there is nothing to scope it to, and nothing is kept.
 * - The Files page's type policy and size cap apply, the stored content type
 *   wins over the browser's, and the filename is length-checked.
 * - No `captureSource`: that field marks files captured from inbound mail (the
 *   retention sweep releases those), and this is a file a person chose to keep.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { internal } from '../_generated/api';
import { DEFAULT_FILE_POLICY, isFileTypeAccepted } from '@owlat/email-scanner';
import { MAX_LIBRARY_FILE_BYTES, MAX_LIBRARY_FILE_MB } from '@owlat/shared/attachments';
import { throwForbidden, throwInvalidInput } from '../_utils/errors';
import { STRING_LIMITS, validateStringLength } from './inputGuards';
import { hasPermission, type MutationSessionContext } from './sessionOrganization';
import { insertSemanticFile } from '../semanticFiles';
import { consumeUpload, storedFileSize } from '../storage/uploads';

/** Whether the caller may keep an uploaded answer in Files (the Files page's rule). */
export function canSaveAnswerToFiles(session: Pick<MutationSessionContext, 'role'>): boolean {
	return hasPermission(session.role, 'organization:manage');
}

/**
 * The same ownership test `consumeUpload` applies, without claiming the upload:
 * a file answer must only ever name the caller's own, still unclaimed upload.
 */
export async function assertOwnUnclaimedUpload(
	ctx: QueryCtx,
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
 * Save a blob to Files for a contact and return the new row. `claim` says who
 * owns the blob until now: `'upload'` is the caller's fresh upload, whose
 * receipt is consumed for the row; `'copy'` is a copy the caller just stored
 * (the upload itself went to a reply), which gets a bound receipt of its own
 * so deleting the row frees it. Throws forbidden for a caller who may not add
 * to Files, invalid-input for a file type or size Files refuses.
 */
export async function saveAnswerFileToFiles(
	ctx: MutationCtx,
	session: MutationSessionContext,
	args: {
		storageId: Id<'_storage'>;
		filename: string;
		mimeType?: string | undefined;
		contactId: Id<'contacts'>;
		claim: 'upload' | 'copy';
	}
): Promise<Doc<'semanticFiles'>> {
	if (!canSaveAnswerToFiles(session)) throwForbidden('Only admins can add files to Files');
	validateStringLength(args.filename, STRING_LIMITS.FILENAME, 'filename');
	const metadata = await ctx.db.system.get(args.storageId);
	const mimeType =
		metadata?.contentType && metadata.contentType !== 'application/octet-stream'
			? metadata.contentType
			: (args.mimeType ?? metadata?.contentType ?? 'application/octet-stream');
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
		contactIds: [args.contactId],
	});
	const resourceKey = `semanticFiles:${fileId}`;
	if (args.claim === 'upload') {
		await consumeUpload(ctx, args.storageId, session, resourceKey);
	} else {
		await ctx.db.insert('storageUploads', {
			userId: session.userId,
			organizationId: session.activeOrganizationId,
			status: 'bound',
			storageId: args.storageId,
			resourceKey,
		});
	}
	await ctx.scheduler.runAfter(0, internal.semanticFileProcessing.processFile, { fileId });
	const row = await ctx.db.get(fileId);
	if (!row) throwInvalidInput('Uploaded file not found');
	return row;
}
