/**
 * Previous-release paths of `storage/files.ts`. An editor, media picker,
 * attachment panel or upload dialog in a tab opened before the deploy calls
 * `storage:generateUploadUrl` and `storage:getUrl` by path. Each keeps its old
 * path, builder, auth floor, arguments and result shape, and runs the same
 * body as its replacement. Remove after release 0.6.17.
 */

import { v } from 'convex/values';
import { authedMutation, authedQuery } from './lib/authedFunctions';
import { generateRateLimitedUploadUrl, readMediaAssetUrl } from './storage/files';

/** Remove after release 0.6.17; this release calls `storage/files:generateUploadUrl`. */
// all-members: an upload URL is inert until a gated mutation (media:manage,
// chat attachment) references the stored blob.
export const generateUploadUrl = authedMutation({
	args: {},
	handler: async (ctx, _args, session) => await generateRateLimitedUploadUrl(ctx, session),
});

/** Remove after release 0.6.17; this release calls `storage/files:getUrl`. */
// authz: readMediaAssetUrl resolves only a shared-library media asset's blob,
// which workspaces/mediaAssets.list already shows every member; anything else is not found.
export const getUrl = authedQuery({
	args: { storageId: v.id('_storage') },
	handler: async (ctx, args) => await readMediaAssetUrl(ctx, args.storageId),
});
