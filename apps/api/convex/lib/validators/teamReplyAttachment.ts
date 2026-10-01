/**
 * Team inbox reply attachments (`conversationThreads.replyAttachments`,
 * `inboundMessages.replyAttachments`, `inboxFollowUps.attachments`).
 *
 * Same field names as the Postbox draft attachment (`mailDraftAttachmentValidator`:
 * `storageId`, `filename`, `contentType`, `size`) so the web can render both
 * with one chip. It drops `isInline`/`contentId`, because a team reply is a
 * plain-text body with no inline images, and adds what a shared composer needs:
 * a stable `id`, where the bytes came from, and who attached them.
 *
 * Every blob named here is OWNED by the reply: a fresh upload is bound to it
 * (`storage/uploads.consumeUpload`), and a file picked from Files or from a
 * received email is COPIED into a new blob first. Referencing the original was
 * not safe: the inbound retention sweep releases team-inbox captures past the
 * horizon, deleting a file from Files deletes its blob, and a mail attachment's
 * bytes are sealed at rest inside the raw message. So removing an attachment,
 * erasing a contact or deleting the workspace may delete these blobs outright.
 *
 * The list moves with the reply: the thread holds what the composer is
 * building, the inbound message holds what its approved reply carried, and a
 * follow-up row holds what it carried. Handlers: `inbox/replyAttachments.ts`.
 */

import { v, type Infer } from 'convex/values';

export const teamReplyAttachmentOriginValidator = v.union(
	v.literal('upload'),
	v.literal('semanticFile'),
	v.literal('mailAttachment')
);

export const teamReplyAttachmentValidator = v.object({
	// Stable handle, so a finished copy finds its entry after others were removed.
	id: v.string(),
	// Absent while a picked file is still being copied, and on a copy that failed.
	storageId: v.optional(v.id('_storage')),
	filename: v.string(),
	contentType: v.string(),
	size: v.number(),
	origin: teamReplyAttachmentOriginValidator,
	// The `semanticFiles` / `mailAttachments` id a copy was made from.
	sourceId: v.optional(v.string()),
	// Why the copy failed. The entry stays so the person sees it and removes it.
	copyError: v.optional(v.string()),
	// BetterAuth user id of the person who attached it (never the agent).
	addedBy: v.string(),
	addedAt: v.number(),
});

export const teamReplyAttachmentsValidator = v.array(teamReplyAttachmentValidator);

export type TeamReplyAttachment = Infer<typeof teamReplyAttachmentValidator>;
