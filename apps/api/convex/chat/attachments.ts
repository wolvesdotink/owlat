/**
 * Chat attachment upload flow.
 *
 * Reuses `mediaAssets` storage records, with a reserved tag that excludes them
 * from the shared media library. Downloads require room access. Upload sequence:
 *   1. Frontend calls `generateUploadUrl` to get a one-use upload capability.
 *   2. Frontend POSTs the file blob to that URL.
 *   3. Frontend calls `registerAttachment` with the resulting storageId; we
 *      insert a `mediaAssets` row and return its id, which the frontend
 *      includes in `chat.messages.sendMessage` as part of `attachmentIds`.
 */

import { v } from 'convex/values';
import { getUserIdFromSession, requireOrgPermission } from '../lib/sessionOrganization';
import { throwInvalidInput, throwRateLimited } from '../_utils/errors';
import { rateLimiter } from '../rateLimiter';
import { chatQuery, chatMutation, assertCanReadRoom, getRoomOrThrow } from './_helpers';
import { MAX_ATTACHMENT_BYTES } from '@owlat/shared/attachments';
import { assertUnregisteredMediaStorage } from './attachmentAccess';
import { consumeUpload, mintUploadUrl } from '../storage/uploads';

/**
 * Generate a one-use upload URL that the browser can POST a file to. The URL
 * is short-lived (~1 hour, controlled by Convex storage policy).
 */
export const generateUploadUrl = chatMutation({
	args: {},
	handler: async (ctx, _args, session) => {
		await requireOrgPermission(ctx, 'chat:participate', 'Chat is not available');
		const limit = await rateLimiter.limit(ctx, 'storageUpload', { key: session.userId });
		if (!limit.ok) throwRateLimited('Too many uploads — try again in a moment.', limit.retryAfter);
		return await mintUploadUrl(ctx, session);
	},
});

/**
 * Register an uploaded blob as a media asset. Returns the mediaAssets id
 * which the frontend then passes to `chat.messages.sendMessage`.
 */
export const registerAttachment = chatMutation({
	args: {
		storageId: v.id('_storage'),
		filename: v.string(),
		mimeType: v.string(),
		fileSize: v.number(),
		width: v.optional(v.number()),
		height: v.optional(v.number()),
	},
	handler: async (ctx, args) => {
		const session = await requireOrgPermission(ctx, 'chat:participate', 'Chat is not available');
		const { userId } = session;

		if (!args.filename.trim()) throwInvalidInput('Filename cannot be empty');
		if (!args.mimeType.trim()) throwInvalidInput('MIME type cannot be empty');
		if (args.fileSize <= 0) throwInvalidInput('File size must be positive');
		if (args.fileSize > MAX_ATTACHMENT_BYTES) {
			throwInvalidInput(
				`File exceeds ${Math.floor(MAX_ATTACHMENT_BYTES / 1024 / 1024)} MiB attachment limit`
			);
		}

		await assertUnregisteredMediaStorage(ctx, args.storageId);
		const url = await ctx.storage.getUrl(args.storageId);
		if (!url) throwInvalidInput('Uploaded blob is missing or expired');

		const now = Date.now();
		const assetId = await ctx.db.insert('mediaAssets', {
			storageId: args.storageId,
			filename: args.filename.trim(),
			mimeType: args.mimeType.trim(),
			fileSize: args.fileSize,
			width: args.width,
			height: args.height,
			url,
			uploadedBy: userId,
			tags: ['chat-attachment'],
			searchableText: args.filename.toLowerCase(),
			createdAt: now,
			updatedAt: now,
		});
		await consumeUpload(ctx, args.storageId, session, `mediaAssets:${assetId}`);
		return assetId;
	},
});

/**
 * Hydrate a message's attachments into renderable info (url + dimensions) for
 * drawing attachment chips.
 *
 * Authorization is bound to the *message*, not the raw asset ids: the caller
 * must be able to READ the message's room (public channel, or a private
 * channel / DM they are a member of). Only the asset ids actually referenced
 * by that message are returned. This prevents the previous IDOR where any
 * authenticated member could fetch the signed download URL of *any* attachment
 * — including those posted in private channels and DMs they were not part of —
 * just by passing arbitrary `mediaAssets` ids.
 */
export const getAttachmentDetails = chatQuery({
	args: { messageId: v.id('chatMessages') },
	handler: async (ctx, args) => {
		const userId = await getUserIdFromSession(ctx);

		const message = await ctx.db.get(args.messageId);
		if (!message) return [];

		// Gate on room access — throws if the caller cannot read this room.
		const room = await getRoomOrThrow(ctx, message.roomId);
		await assertCanReadRoom(ctx, room, userId);

		// The attachment rows are independent of each other.
		const assets = await Promise.all((message.attachmentIds ?? []).map((id) => ctx.db.get(id)));
		const result = [];
		for (const asset of assets) {
			if (!asset) continue;
			result.push({
				_id: asset._id,
				filename: asset.filename,
				mimeType: asset.mimeType,
				fileSize: asset.fileSize,
				width: asset.width ?? null,
				height: asset.height ?? null,
				url: asset.url,
			});
		}
		return result;
	},
});
