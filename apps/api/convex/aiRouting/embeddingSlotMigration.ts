/**
 * Moving a space's vectors to its new column (ADR-0073; `reslotSpace` in
 * `lib/aiRouting/embeddingRegistry.ts`).
 *
 * A space that must change columns (it is reactivated or attested while the
 * active space uses its column) keeps its vectors in the old column until this
 * bounded chain copies them, with their provenance, into the new one. The old
 * column then belongs to the other space alone, so its vectors are never
 * re-embedded over. No provider is called: the vectors already exist.
 *
 * Pages through the old column's index for this space, so the range is stable
 * (copying does not change the old column). A page is idempotent: a row whose
 * new column already holds this space's vector is left alone. The chain stops
 * if the space moved again or was deleted; the move that started it starts
 * another.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation } from '../lib/writeFence';
import {
	copyFieldsIntoSlot,
	otherSlot,
	vectorInSpace,
	spaceRefOf,
} from '../lib/aiRouting/embeddingRegistry';
import { embeddingTableValidator } from '../lib/validators/embedding';

const MIGRATION_PAGE_SIZE = 64;

export const migratePage = internalMutation({
	args: {
		spaceId: v.id('embeddingSpaces'),
		table: embeddingTableValidator,
		cursor: v.union(v.string(), v.null()),
	},
	handler: async (ctx, args) => {
		const space = await ctx.db.get(args.spaceId);
		if (!space) return;
		const from = otherSlot(space.slot);
		const page =
			from === 'primary'
				? await ctx.db
						.query(args.table)
						.withIndex('by_embedding_space', (q) => q.eq('embeddingSpaceId', space._id))
						.paginate({ cursor: args.cursor, numItems: MIGRATION_PAGE_SIZE })
				: await ctx.db
						.query(args.table)
						.withIndex('by_secondary_embedding_space', (q) =>
							q.eq('secondaryEmbeddingSpaceId', space._id)
						)
						.paginate({ cursor: args.cursor, numItems: MIGRATION_PAGE_SIZE });
		const target = spaceRefOf(space);
		for (const row of page.page) {
			if (vectorInSpace(row, target)) continue;
			const entryType =
				args.table === 'knowledgeEntries' ? (row as Doc<'knowledgeEntries'>).entryType : undefined;
			const fields = copyFieldsIntoSlot(row, space, entryType);
			if (fields) await ctx.db.patch(row._id, fields);
		}
		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingSlotMigration.migratePage, {
				...args,
				cursor: page.continueCursor,
			});
		} else if (args.table === 'knowledgeEntries') {
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingSlotMigration.migratePage, {
				spaceId: args.spaceId,
				table: 'semanticFiles',
				cursor: null,
			});
		} else {
			await ctx.scheduler.runAfter(0, internal.aiRouting.embeddingCoverage.requestScan, {
				isForced: true,
			});
		}
	},
});
