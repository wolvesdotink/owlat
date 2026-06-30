import { authedMutation, authedQuery } from './lib/authedFunctions';
import { getUserIdFromSession, requireAdminContext } from './lib/sessionOrganization';
import { v } from 'convex/values';
import { throwNotFound } from './_utils/errors';

/**
 * Generate an upload URL for file storage.
 * This URL can be used to upload files directly from the client.
 */
// all-members: an upload URL is inert until a gated mutation (media:manage,
// chat attachment) references the stored blob.
export const generateUploadUrl = authedMutation({
	args: {},
	handler: async (ctx) => {
		// Require authentication before generating upload URLs
		await getUserIdFromSession(ctx);
		return await ctx.storage.generateUploadUrl();
	},
});

/**
 * Get a signed download URL for a stored file by its storage ID.
 *
 * Authentication alone is NOT sufficient: a `_storage` id is opaque and shared
 * across resources (mail body/raw blobs, attachments, semantic files all live
 * in the same `_storage` namespace), so handing any authenticated member a URL
 * for any storage id is a cross-resource IDOR — it structurally bypasses the
 * per-resource ownership gates (e.g. mail's `loadReadableMessage`). This query
 * therefore resolves ONLY blobs that are backed by a `mediaAssets` row, the
 * media-library / editor surface its three callers actually use. It mirrors the
 * sibling `deleteFile` ownership lookup. Resources that store blobs outside the
 * media library expose their own ownership-gated URL accessor (mail's
 * `getMessageRawUrl`, etc.) and must NOT be routed through here.
 */
export const getUrl = authedQuery({
	args: { storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		await getUserIdFromSession(ctx);

		// Only a blob owned by a media asset is resolvable through this endpoint.
		const owningAsset = await ctx.db
			.query('mediaAssets')
			.withIndex('by_storage_id', (q) => q.eq('storageId', args.storageId))
			.first();

		if (!owningAsset) {
			throwNotFound('File');
		}

		return await ctx.storage.getUrl(args.storageId);
	},
});

/**
 * Delete a file from storage by its storage ID.
 * Verifies the file belongs to the caller via mediaAssets ownership.
 */
export const deleteFile = authedMutation({
	args: { storageId: v.id('_storage') },
	handler: async (ctx, args) => {
		// Deleting a stored blob is admin-only: blobs back media assets, whose own
		// delete path requires media:manage (admin). Gate the raw blob delete the
		// same way.
		await requireAdminContext(ctx);

		// Verify the storage file belongs to the instance via mediaAssets ownership.
		const owningAsset = await ctx.db
			.query('mediaAssets')
			.withIndex('by_storage_id', (q) => q.eq('storageId', args.storageId))
			.first();

		if (!owningAsset) {
			throwNotFound('File');
		}

		await ctx.storage.delete(args.storageId);
	},
});
