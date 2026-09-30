/**
 * Project open-commitment facets onto existing knowledge junction rows
 * (issue #919, migration 0051).
 *
 * New and edited knowledge entries already write `isOpenCommitment` and its
 * sort keys onto their `knowledgeEntryContacts` rows
 * (knowledge/commitmentFacets.ts). This back-fill fills the rows written
 * before that change, so the agent's open-commitments recall stops loading
 * every knowledge entry of a contact.
 *
 *   npx convex run migrations/0051_project_open_commitments:run
 *
 * SAFE AT ANY POINT: the recall reads projected rows through the new index and
 * hydrates rows without facets the old way, so a half-projected table answers
 * exactly like a finished one. Nothing waits on this.
 *
 * DURABLE AND RESUMABLE: `run` schedules the first page; each page is its own
 * mutation that schedules the next one with its cursor, so the walk survives a
 * restart of the caller and continues in the background after `run` returns.
 * Every page logs its cursor; `run '{"cursor":"..."}'` resumes from one.
 * Idempotent: a row that already carries facets is left alone, so re-running
 * after an interrupt or on a finished instance writes nothing twice.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { commitmentFacetsOf } from '../knowledge/commitmentFacets';
import { logInfo } from '../lib/runtimeLog';

/**
 * Junction rows per page. Each unprojected row loads its entry once (about
 * 14 KB with the 1,536-number embedding), so 100 rows stay near 1.4 MB read.
 */
const PAGE_SIZE = 100;

type PageResult = { cursor: string; isDone: boolean; scanned: number; projected: number };

/** Project one page of junction rows; schedules the next page while `chain` is set. */
export const projectPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), chain: v.optional(v.boolean()) },
	handler: async (ctx, { cursor, chain }): Promise<PageResult> => {
		const { page, continueCursor, isDone } = await ctx.db
			.query('knowledgeEntryContacts')
			.paginate({ numItems: PAGE_SIZE, cursor });
		let projected = 0;
		for (const row of page) {
			if (row.isOpenCommitment !== undefined) continue;
			const entry = await ctx.db.get(row.entryId);
			// An orphan row (its entry is gone) has nothing to recall: marking it
			// not-open keeps the reader from hydrating it on every call.
			await ctx.db.patch(
				row._id,
				entry
					? commitmentFacetsOf(entry)
					: {
							isOpenCommitment: false,
							commitmentDueKey: undefined,
							commitmentOrderKey: undefined,
							entryExpiresAt: undefined,
						}
			);
			projected++;
		}
		logInfo('migration.0051_project_open_commitments.page', {
			scanned: page.length,
			projected,
			cursor: continueCursor,
			isDone,
		});
		if (chain && !isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0051_project_open_commitments'].projectPage,
				{ cursor: continueCursor, chain: true }
			);
		}
		return { cursor: continueCursor, isDone, scanned: page.length, projected };
	},
});

/** Start (or, with a logged `cursor`, resume) the background walk. */
export const run = internalMutation({
	args: { cursor: v.optional(v.union(v.string(), v.null())) },
	handler: async (ctx, args): Promise<{ started: true }> => {
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0051_project_open_commitments'].projectPage,
			{ cursor: args.cursor ?? null, chain: true }
		);
		logInfo('migration.0051_project_open_commitments.started', { cursor: args.cursor ?? null });
		return { started: true };
	},
});
