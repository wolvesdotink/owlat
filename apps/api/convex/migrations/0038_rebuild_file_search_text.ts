/**
 * Rebuild `semanticFiles.searchableText` for existing rows (migration 0038).
 *
 * File search reads only `searchableText`, and until now that field was built
 * from the filename and upload-time title alone on insert, and never rebuilt
 * when the title or tags were edited. Files uploaded before this change are
 * therefore missing their tags (and, for rows the processing pipeline reached
 * before the LLM was configured, their summary/auto-tags/extracted text) from
 * the index, so searching for a tag finds nothing.
 *
 * An operator runs `convex run migrations/0038_rebuild_file_search_text:run`
 * once. The walk is page-at-a-time and idempotent — `buildFileSearchableText`
 * is a pure function of the row, so re-running (or running on an instance that
 * has none of the legacy rows) rewrites nothing and is safe to resume after an
 * interrupt.
 */

import { v } from 'convex/values';
import { internalAction, internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { buildFileSearchableText } from '../lib/fileSearchText';

/** Rows per page. Small enough to stay well inside a mutation's limits. */
const PAGE_SIZE = 100;

interface PageResult {
	cursor: string;
	isDone: boolean;
	rebuilt: number;
}

export const rebuildPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()) },
	handler: async (ctx, args): Promise<PageResult> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('semanticFiles')
			.paginate({ numItems: PAGE_SIZE, cursor: args.cursor });

		let rebuilt = 0;
		for (const file of page) {
			const searchableText = buildFileSearchableText({
				filename: file.filename,
				title: file.title,
				summary: file.summary,
				tags: file.tags,
				autoTags: file.autoTags,
				extractedText: file.extractedText,
			});
			if (searchableText === file.searchableText) continue;
			await ctx.db.patch(file._id, { searchableText });
			rebuilt++;
		}

		return { cursor: continueCursor, isDone, rebuilt };
	},
});

export const run = internalAction({
	args: {},
	handler: async (ctx): Promise<{ rebuilt: number; pages: number }> => {
		let cursor: string | null = null;
		let rebuilt = 0;
		let pages = 0;
		// Bounded so a pagination bug can never spin forever; at PAGE_SIZE=100
		// this covers a library of 100k files in one invocation, and a larger
		// one finishes by re-running (the walk restarts from the top and skips
		// every already-correct row).
		for (; pages < 1000; pages++) {
			const result: PageResult = await ctx.runMutation(
				internal.migrations['0038_rebuild_file_search_text'].rebuildPage,
				{ cursor }
			);
			rebuilt += result.rebuilt;
			if (result.isDone) break;
			cursor = result.cursor;
		}
		return { rebuilt, pages: pages + 1 };
	},
});
