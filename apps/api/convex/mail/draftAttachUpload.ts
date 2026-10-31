/**
 * Put a fresh upload on a Postbox draft: the one implementation behind
 * `drafts.addAttachment` and Answer mode's file answers, which attach in the
 * same commit as the answer (mail/ai/composeDraftCommit.ts).
 */

import { v, type ObjectType } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { consumeUpload, storedFileSize } from '../storage/uploads';
import { claimThreadAnswerUpload } from './needsReplyPrepared';
import { requireMailboxAccess } from './permissions';
import { assertStateIs } from './draftLifecycle/reducers';
import { getOrThrow, throwForbidden, throwInvalidInput } from '../_utils/errors';
import { humanEdit } from './draftProvenance';
import type { MutationSessionContext } from '../lib/sessionOrganization';

export const attachUploadArgs = {
	draftId: v.id('mailDrafts'),
	storageId: v.id('_storage'),
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	isInline: v.optional(v.boolean()),
	contentId: v.optional(v.string()),
};

/**
 * Attach the caller's upload (or one a Reply Queue answer holds for the
 * draft's thread) to a draft the caller can write, within the compose limits.
 * Throws on a draft out of reach, an upload that is not the caller's to use, or
 * a limit.
 */
export async function attachUploadToDraft(
	ctx: MutationCtx,
	session: MutationSessionContext,
	args: ObjectType<typeof attachUploadArgs>
): Promise<void> {
	const draft = await getOrThrow(ctx, args.draftId, 'Draft');
	const owned = await requireMailboxAccess(ctx, draft.mailboxId);
	if (!owned.ok) throwForbidden('Draft not accessible');
	assertStateIs(draft, 'draft');
	// An upload answered on the Reply Queue is held by the thread until a
	// draft of it takes it over; any other is the caller's fresh upload.
	const isTakenFromThread = await claimThreadAnswerUpload(
		ctx,
		args.storageId,
		draft,
		session.activeOrganizationId
	);
	if (!isTakenFromThread) {
		await consumeUpload(ctx, args.storageId, session, `mailDrafts:${args.draftId}`);
	}
	if (draft.attachments.length >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
		throwInvalidInput('Too many attachments');
	}
	const size = await storedFileSize(ctx, args.storageId);
	if (size <= 0 || size > MAX_ATTACHMENT_BYTES)
		throwInvalidInput('Attachment size exceeds the allowed limit');
	// Inline images are transmitted too. Re-read legacy attachment sizes so
	// previously underreported rows cannot evade the total-byte limit.
	const existingSizes = await Promise.all(
		draft.attachments.map((attachment) => storedFileSize(ctx, attachment.storageId))
	);
	if (
		existingSizes.reduce((total, bytes) => total + bytes, size) >
		ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes
	) {
		throwInvalidInput('Attachments exceed the total size limit');
	}

	await ctx.db.patch(args.draftId, {
		attachments: [
			...draft.attachments,
			{
				storageId: args.storageId,
				filename: args.filename,
				contentType: args.contentType,
				size,
				isInline: args.isInline ?? false,
				contentId: args.contentId,
			},
		],
		...humanEdit(Date.now()),
	});
}
