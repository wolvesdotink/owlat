/**
 * File answers for the background clarification loops: the owner answers a
 * "which file?" / "I couldn't find it" question with a Files row, a mail
 * attachment, or a fresh upload.
 *
 * Shared by the two answer mutations (`inbox/clarification.ts` for the team
 * pipeline, `mail/ai/needsReplyClarify.ts` for the Postbox Reply Queue). The
 * file reference comes from the client, so every source is re-checked here
 * before it is stored on the answer, with the same read check every other
 * attach path runs (lib/existingAttachments.ts): the row must exist and still
 * hold bytes, a mail attachment must sit in a mailbox the caller can read, and
 * an upload must be the caller's own unclaimed one.
 *
 * An upload is kept in Files by default (decision 5), under the shared rules
 * in lib/answerFileToFiles.ts (admins only, a known contact only), and the
 * answer then points at that row. With `keepCopy: false`, or when no copy may
 * be kept, the upload stays unclaimed and the answer keeps pointing at it.
 */

import type { Infer } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { throwInvalidInput } from '../_utils/errors';
import { validateStringLength, STRING_LIMITS } from '../lib/inputGuards';
import { resolveReadableExistingAttachment } from '../lib/existingAttachments';
import {
	assertOwnUnclaimedUpload,
	canSaveAnswerToFiles,
	saveAnswerFileToFiles,
} from '../lib/answerFileToFiles';
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
	/** Contact the saved copy is scoped to (the sender); nothing is kept without one. */
	contactId?: Id<'contacts'> | undefined;
}

/**
 * Check a file answer and return what to store on the question. Throws a typed
 * not-found / forbidden / invalid error when the reference is unusable, so the
 * owner sees the problem instead of a draft that silently lacks the file.
 */
export async function resolveClarificationFile(
	ctx: MutationCtx,
	session: MutationSessionContext,
	file: ClarificationFileRef,
	options: ResolveOptions
): Promise<ResolvedFileAnswer> {
	if (file.source !== 'upload') {
		const resolved = await resolveReadableExistingAttachment(
			ctx,
			{ source: file.source, id: file.id },
			session
		);
		const ref = { source: resolved.source, id: resolved.id, filename: resolved.filename };
		if (resolved.source === 'mailAttachment') return { ref };
		const row = await ctx.db.get(resolved.id as Id<'semanticFiles'>);
		if (!row) throwInvalidInput('That file is no longer available');
		return { ref, semanticFile: row };
	}

	const storageId = ctx.db.system.normalizeId('_storage', file.id);
	if (!storageId) throwInvalidInput('Uploaded file not found');
	validateStringLength(file.filename, STRING_LIMITS.FILENAME, 'filename');
	await assertOwnUnclaimedUpload(ctx, session, storageId);
	if (options.keepCopy !== false && options.contactId && canSaveAnswerToFiles(session)) {
		const row = await saveAnswerFileToFiles(ctx, session, {
			storageId,
			filename: file.filename,
			mimeType: options.mimeType,
			contactId: options.contactId,
			claim: 'upload',
		});
		return {
			ref: { source: 'semanticFile', id: row._id, filename: row.filename },
			semanticFile: row,
		};
	}
	return { ref: { source: 'upload', id: storageId, filename: file.filename } };
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
