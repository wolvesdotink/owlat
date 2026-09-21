/**
 * Restore the private classification of legacy chat files and their media aliases.
 * Run after deploying the new upload and media access guards:
 *
 *   npx convex run migrations/0044_private_chat_media:run
 *
 * Idempotent and paginated. Chat references are authoritative even if an old
 * library edit removed the reserved tag. Conservatively includes shared assets
 * posted in chat: review those assets and upload a separate shared copy if needed.
 * Previously disclosed storage URLs cannot be recalled by this classification.
 */
import { v } from 'convex/values';
import { internalAction, internalMutation, internalQuery } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { isChatAttachment } from '../chat/attachmentAccess';

const PAGE_SIZE = 100;
type SourcePage = {
	assetIds: Id<'mediaAssets'>[];
	storageIds?: Id<'_storage'>[];
	cursor: string;
	isDone: boolean;
};

export const sourcePage = internalQuery({
	args: {
		source: v.union(v.literal('messages'), v.literal('assets')),
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args): Promise<SourcePage> => {
		if (args.source === 'messages') {
			const page = await ctx.db
				.query('chatMessages')
				.paginate({ numItems: 20, cursor: args.cursor });
			return {
				assetIds: [...new Set(page.page.flatMap((message) => message.attachmentIds ?? []))],
				cursor: page.continueCursor,
				isDone: page.isDone,
			};
		}
		// Also repair aliases of private uploads that were never posted.
		const page = await ctx.db
			.query('mediaAssets')
			.withIndex('by_storage_id')
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
		const privateAssets = page.page.filter(isChatAttachment);
		return {
			assetIds: privateAssets.map((asset) => asset._id),
			storageIds: privateAssets.map((asset) => asset.storageId),
			cursor: page.continueCursor,
			isDone: page.isDone,
		};
	},
});

export const markReferenced = internalMutation({
	args: { assetId: v.id('mediaAssets') },
	handler: async (ctx, args) => {
		const asset = await ctx.db.get(args.assetId);
		if (!asset || isChatAttachment(asset)) return 0;
		await ctx.db.patch(asset._id, {
			tags: [...(asset.tags ?? []), 'chat-attachment'],
			updatedAt: Date.now(),
		});
		return 1;
	},
});

export const retagAliases = internalMutation({
	args: { assetId: v.id('mediaAssets'), cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args) => {
		const asset = await ctx.db.get(args.assetId);
		if (!asset) return { updated: 0, cursor: '', isDone: true };
		const page = await ctx.db
			.query('mediaAssets')
			.withIndex('by_storage_id', (q) => q.eq('storageId', asset.storageId))
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
		let updated = 0;
		for (const alias of page.page) {
			if (isChatAttachment(alias)) continue;
			await ctx.db.patch(alias._id, {
				tags: [...(alias.tags ?? []), 'chat-attachment'],
				updatedAt: Date.now(),
			});
			updated++;
		}
		return { updated, cursor: page.continueCursor, isDone: page.isDone };
	},
});

export const run = internalAction({
	args: {},
	handler: async (ctx): Promise<{ updated: number }> => {
		let updated = 0;
		for (const source of ['messages', 'assets'] as const) {
			let cursor: string | null = null;
			let previousStorageId: Id<'_storage'> | undefined;
			for (;;) {
				const page: SourcePage = await ctx.runQuery(
					internal.migrations['0044_private_chat_media'].sourcePage,
					{ source, cursor }
				);
				for (const [index, assetId] of page.assetIds.entries()) {
					if (source === 'messages') {
						updated += await ctx.runMutation(
							internal.migrations['0044_private_chat_media'].markReferenced,
							{ assetId }
						);
						continue;
					}
					// The second pass is storage-ordered, so even a large alias group
					// crossing pages is repaired once, without an unbounded seen set.
					const storageId = page.storageIds?.[index];
					if (storageId === previousStorageId) continue;
					previousStorageId = storageId;
					let aliasCursor: string | null = null;
					for (;;) {
						const aliases: { updated: number; cursor: string; isDone: boolean } =
							await ctx.runMutation(internal.migrations['0044_private_chat_media'].retagAliases, {
								assetId,
								cursor: aliasCursor,
							});
						updated += aliases.updated;
						if (aliases.isDone) break;
						aliasCursor = aliases.cursor;
					}
				}
				if (page.isDone) break;
				cursor = page.cursor;
			}
		}
		return { updated };
	},
});
