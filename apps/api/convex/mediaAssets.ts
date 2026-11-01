/**
 * Previous-release paths of `workspaces/mediaAssets.ts` and
 * `workspaces/mediaAssetScan.ts`. The media library, the media picker, the
 * attachment panel and the email editor's image upload in a tab opened before
 * the deploy call `mediaAssets:*` by path, and a byte scan the previous
 * release queued for an upload runs as `mediaAssets:scanAssetBytes`. Each
 * keeps its old path, builder, auth floor, arguments and result shape, and
 * runs the same body as its replacement. Remove after release 0.6.17.
 */
import { internalAction } from './_generated/server';
import { internalMutation } from './lib/writeFence';
import { authedMutation, authedQuery } from './lib/authedFunctions';
import {
	bulkDeleteArgs,
	bulkDeleteMediaAssets,
	countAssetUsage,
	countUsageArgs,
	createArgs,
	createMediaAsset,
	listArgs,
	listMediaAssets,
	listMediaTags,
	mediaLibraryStats,
	updateArgs,
	updateMediaAsset,
} from './workspaces/mediaAssets';
import {
	quarantineAssetArgs,
	quarantineStoredAsset,
	reconcileAssetSizeArgs,
	reconcileStoredAssetSize,
	scanAssetBytesArgs,
	scanStoredAssetBytes,
} from './workspaces/mediaAssetScan';

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssets:list`. */
// all-members: the shared media library every role uses in the email editor;
// chat attachments are dropped (their room owns that read), and writing the
// library needs media:manage.
export const list = authedQuery({
	args: listArgs,
	handler: async (ctx, args) => await listMediaAssets(ctx, args),
});

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssets:getStats`. */
// all-members: count and size of the shared library, chat attachments left out.
export const getStats = authedQuery({
	args: {},
	handler: async (ctx) => await mediaLibraryStats(ctx),
});

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssets:countUsage`. */
// all-members: read-only reference count for the media library, shown in the
// asset detail panel — same member-visible posture as list / getStats.
export const countUsage = authedQuery({
	args: countUsageArgs,
	handler: async (ctx, args) => await countAssetUsage(ctx, args.assetId),
});

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssets:listTags`. */
// all-members: the tag filter of the shared library, chat attachments left out.
export const listTags = authedQuery({
	args: {},
	handler: async (ctx) => await listMediaTags(ctx),
});

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssets:create`. */
// authz: createMediaAsset requires media:manage before it writes.
export const create = authedMutation({
	args: createArgs,
	handler: async (ctx, args, session) => await createMediaAsset(ctx, args, session),
});

/** Remove after release 0.6.17; this release schedules `workspaces/mediaAssetScan:scanAssetBytes`. */
export const scanAssetBytes = internalAction({
	args: scanAssetBytesArgs,
	handler: async (ctx, args) => await scanStoredAssetBytes(ctx, args),
});

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssetScan:reconcileAssetSize`. */
export const reconcileAssetSize = internalMutation({
	args: reconcileAssetSizeArgs,
	handler: async (ctx, args) => await reconcileStoredAssetSize(ctx, args),
});

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssetScan:quarantineAsset`. */
export const quarantineAsset = internalMutation({
	args: quarantineAssetArgs,
	handler: async (ctx, args) => await quarantineStoredAsset(ctx, args),
});

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssets:update`. */
// authz: updateMediaAsset requires media:manage before it reads or writes.
export const update = authedMutation({
	args: updateArgs,
	handler: async (ctx, args, session) => await updateMediaAsset(ctx, args, session),
});

/** Remove after release 0.6.17; this release calls `workspaces/mediaAssets:bulkDelete`. */
// authz: bulkDeleteMediaAssets requires media:manage before it reads or writes.
export const bulkDelete = authedMutation({
	args: bulkDeleteArgs,
	handler: async (ctx, args, session) => await bulkDeleteMediaAssets(ctx, args.assetIds, session),
});
