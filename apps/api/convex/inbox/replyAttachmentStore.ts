/**
 * Team inbox reply attachments: the rules shared by the composer's mutations
 * (`./replyAttachments.ts`), the send paths (`./mutations.ts approveDraft`,
 * `./followUps.ts`, the agent reply intake) and the deletion cascades.
 *
 * The thread holds the list the composer is building. A send TAKES the ready
 * entries off the thread and keeps them on its own record: the inbound message
 * for an approved reply, the follow-up row for a follow-up. So the composer is
 * empty again after a send, and the thread's history still says what went out.
 *
 * Every blob in these lists belongs to the reply (see
 * `lib/validators/teamReplyAttachment.ts`), which is why {@link
 * purgeReplyAttachments} may delete it without asking anything else.
 */

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { ATTACHMENT_COMPOSE_LIMITS, MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import type { TeamReplyAttachment } from '../lib/validators/teamReplyAttachment';
import type { AttachmentRef } from '../delivery/sendComposition';
import { deleteBlobQuietly } from '../lib/storageBlobs';
import { throwInvalidInput, throwInvalidState } from '../_utils/errors';

/** The `storageUploads.resourceKey` a fresh upload is bound to. */
export function replyUploadResourceKey(threadId: Id<'conversationThreads'>): string {
	return `teamReply:${threadId}`;
}

type ReplyAttachmentStatus = 'ready' | 'copying' | 'failed';

export function replyAttachmentStatus(entry: TeamReplyAttachment): ReplyAttachmentStatus {
	if (entry.storageId) return 'ready';
	return entry.copyError === undefined ? 'copying' : 'failed';
}

/**
 * Throw unless one more file of `size` bytes fits beside `existing`: the same
 * count, per-file and total limits a Postbox draft enforces
 * (`mail/drafts.addAttachment`). A file still being copied counts at the size
 * its source recorded.
 */
export function assertReplyAttachmentFits(
	existing: readonly TeamReplyAttachment[],
	size: number
): void {
	if (existing.length >= ATTACHMENT_COMPOSE_LIMITS.maxCount) {
		throwInvalidInput('Too many attachments');
	}
	if (size <= 0 || size > MAX_ATTACHMENT_BYTES) {
		throwInvalidInput('Attachment size exceeds the allowed limit');
	}
	const total = existing.reduce((sum, entry) => sum + entry.size, size);
	if (total > ATTACHMENT_COMPOSE_LIMITS.maxTotalBytes) {
		throwInvalidInput('Attachments exceed the total size limit');
	}
}

/**
 * A person is about to send: refuse while a picked file is still being copied
 * or failed to copy, rather than send without it. The autonomous path does not
 * ask; it takes what is ready ({@link takeReadyReplyAttachments}).
 */
export async function assertReplyAttachmentsReady(
	ctx: QueryCtx,
	threadId: Id<'conversationThreads'> | undefined
): Promise<void> {
	if (!threadId) return;
	const thread = await ctx.db.get(threadId);
	for (const entry of thread?.replyAttachments ?? []) {
		const status = replyAttachmentStatus(entry);
		if (status === 'copying') {
			throwInvalidState(`"${entry.filename}" is still being attached. Try again in a moment.`);
		}
		if (status === 'failed') {
			throwInvalidState(`"${entry.filename}" could not be attached. Remove it before sending.`);
		}
	}
}

/**
 * Take the composer's ready attachments off the thread for a send. What is
 * still being copied (or failed), and what `include` turns down, stays on the
 * thread.
 */
export async function takeReadyReplyAttachments(
	ctx: MutationCtx,
	thread: Doc<'conversationThreads'> | null,
	include: (entry: TeamReplyAttachment) => boolean = () => true
): Promise<TeamReplyAttachment[]> {
	const entries = thread?.replyAttachments ?? [];
	const isTaken = (entry: TeamReplyAttachment) =>
		replyAttachmentStatus(entry) === 'ready' && include(entry);
	const ready = entries.filter(isTaken);
	if (!thread || ready.length === 0) return [];
	const left = entries.filter((entry) => !isTaken(entry));
	await ctx.db.patch(thread._id, { replyAttachments: left.length > 0 ? left : undefined });
	return ready;
}

/** Put attachments back into the thread's composer (a follow-up's Undo). */
export async function returnReplyAttachments(
	ctx: MutationCtx,
	threadId: Id<'conversationThreads'>,
	entries: readonly TeamReplyAttachment[] | undefined
): Promise<void> {
	if (!entries || entries.length === 0) return;
	const thread = await ctx.db.get(threadId);
	if (!thread) {
		await purgeReplyAttachments(ctx, entries, '[team reply] returned to a deleted thread');
		return;
	}
	await ctx.db.patch(threadId, {
		replyAttachments: [...entries, ...(thread.replyAttachments ?? [])],
	});
}

/**
 * The worker refs for a send: own-storage refs, read directly by the worker
 * (`delivery/attachmentFetch.ts`). Throws a plain Error when a blob is gone:
 * only send paths call this, and they record the message as the failure.
 */
export async function replyAttachmentRefs(
	ctx: QueryCtx,
	entries: readonly TeamReplyAttachment[] | undefined
): Promise<AttachmentRef[]> {
	const refs: AttachmentRef[] = [];
	for (const entry of entries ?? []) {
		if (!entry.storageId) continue;
		const url = await ctx.storage.getUrl(entry.storageId);
		if (!url) throw new Error(`The attachment "${entry.filename}" is no longer stored`);
		refs.push({
			filename: entry.filename,
			contentType: entry.contentType,
			url,
			storageId: entry.storageId,
		});
	}
	return refs;
}

/**
 * Delete the blobs these entries own, and the upload receipt of a fresh upload
 * so no dangling "bound" receipt names a deleted blob. Never throws.
 *
 * `onRead` is told about each receipt read, for a caller that accounts for the
 * documents its transaction reads (contact erasure's byte budget).
 */
export async function purgeReplyAttachments(
	ctx: Pick<MutationCtx, 'db' | 'storage'>,
	entries: readonly TeamReplyAttachment[] | undefined,
	logTag: string,
	onRead?: (doc: unknown) => void
): Promise<void> {
	for (const entry of entries ?? []) {
		if (!entry.storageId) continue;
		const storageId = entry.storageId;
		const receipt = await ctx.db
			.query('storageUploads')
			.withIndex('by_storage', (q) => q.eq('storageId', storageId))
			.unique();
		if (receipt) {
			onRead?.(receipt);
			await ctx.db.delete(receipt._id);
		}
		await deleteBlobQuietly(ctx.storage, storageId, logTag, { attachmentId: entry.id });
	}
}
