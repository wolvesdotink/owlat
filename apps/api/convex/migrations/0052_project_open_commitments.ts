/**
 * Project open-commitment facets onto existing knowledge junction rows
 * (issue #919, migration 0052).
 *
 * New and edited knowledge entries already write `isOpenCommitment` and its
 * sort keys onto their `knowledgeEntryContacts` rows
 * (knowledge/commitmentFacets.ts). This back-fill fills the rows written
 * before that change, so the agent's open-commitments recall stops loading
 * every knowledge entry of a contact.
 *
 *   npx convex run migrations/0052_project_open_commitments:run
 *
 * SAFE AT ANY POINT: the recall reads projected rows through the new index and
 * hydrates rows without facets the old way, so a half-projected table answers
 * exactly like a finished one. Nothing waits on this.
 *
 * DURABLE AND RESUMABLE: `run` schedules the first page; each page is its own
 * mutation that schedules the next one. Progress and completion live in the
 * migration ledger (`migrationRuns` row `0052_project_open_commitments`,
 * lib/migrationLedger.ts): each page records its cursor and counts in the same
 * transaction as its writes, and the final page marks the row `completed`.
 *
 * Running `run` again on an unfinished pass resumes it from the recorded
 * cursor and supersedes any chain still queued; on a finished one it does
 * nothing (`'{"restart":true}'` starts a fresh pass). Pages are idempotent: a
 * row that already carries facets is left alone, so redoing a page writes
 * nothing twice.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import { commitmentFacetsOf } from '../knowledge/commitmentFacets';
import { logInfo } from '../lib/runtimeLog';
import type { MutationCtx } from '../_generated/server';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
	type MigrationRun,
} from '../lib/migrationLedger';

const MIGRATION = '0052_project_open_commitments';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.6';

/**
 * Junction rows per page. Each unprojected row loads its entry once (about
 * 14 KB with the 1,536-number embedding), so 100 rows stay near 1.4 MB read.
 */
const PAGE_SIZE = 100;

type PageResult = {
	cursor: string;
	isDone: boolean;
	scanned: number;
	projected: number;
	/** The page belonged to a generation a later start or resume replaced; nothing ran. */
	isSuperseded?: boolean;
};

/** Project the facets of one page of junction rows. */
async function projectRows(
	ctx: MutationCtx,
	cursor: string | null
): Promise<Omit<PageResult, 'isSuperseded'>> {
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
	return { cursor: continueCursor, isDone, scanned: page.length, projected };
}

/**
 * The ledger run a page records into, or null when the page only projects.
 *
 * A page with a `generation` belongs to that ledger run and is dropped when a
 * newer start or resume superseded it. A chained page without one was
 * scheduled by this migration's first, ledger-less shape (remove after release
 * N+1): with no ledger row it becomes the run, otherwise the ledger's own run
 * covers the table and this page projects once and stops. A single page run
 * by hand (no `chain`) projects without touching the ledger.
 */
async function runForPage(
	ctx: MutationCtx,
	args: { cursor: string | null; chain?: boolean; generation?: number }
): Promise<{ run: MigrationRun | null; isSuperseded: boolean }> {
	const run = await readMigrationRun(ctx, MIGRATION);
	if (args.generation !== undefined) {
		return isCurrentMigrationPage(run, args.generation)
			? { run, isSuperseded: false }
			: { run: null, isSuperseded: true };
	}
	if (args.chain && !run) {
		const adopted = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			cursor: args.cursor,
		});
		return { run: adopted, isSuperseded: false };
	}
	return { run: null, isSuperseded: false };
}

/** Project one page of junction rows; while `chain` is set, schedules the next page. */
export const projectPage = internalMutation({
	args: {
		cursor: v.union(v.string(), v.null()),
		chain: v.optional(v.boolean()),
		generation: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<PageResult> => {
		const { run, isSuperseded } = await runForPage(ctx, args);
		if (isSuperseded) {
			logInfo('migration.0052_project_open_commitments.superseded', {
				generation: args.generation ?? null,
			});
			return { cursor: args.cursor ?? '', isDone: false, scanned: 0, projected: 0, isSuperseded };
		}

		const result = await projectRows(ctx, args.cursor);
		if (run) {
			await recordMigrationPage(ctx, run, {
				cursor: result.cursor,
				isDone: result.isDone,
				scanned: result.scanned,
				changed: result.projected,
			});
		}
		logInfo('migration.0052_project_open_commitments.page', {
			scanned: result.scanned,
			projected: result.projected,
			cursor: result.cursor,
			isDone: result.isDone,
			generation: run?.generation ?? null,
		});
		if (run && args.chain && !result.isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0052_project_open_commitments'].projectPage,
				{ cursor: result.cursor, chain: true, generation: run.generation }
			);
		}
		return result;
	},
});

/**
 * Start the background walk, or resume an unfinished one from its recorded
 * cursor (or from `cursor` when given). A finished migration is left alone
 * unless `restart` is set.
 */
export const run = internalMutation({
	args: {
		cursor: v.optional(v.union(v.string(), v.null())),
		restart: v.optional(v.boolean()),
	},
	handler: async (
		ctx,
		args
	): Promise<{ started: boolean; generation?: number; reason?: string }> => {
		const begun = await beginMigrationRun(ctx, {
			migration: MIGRATION,
			introducedIn: INTRODUCED_IN,
			cursor: args.cursor,
			restart: args.restart,
		});
		if (!begun) {
			return { started: false, reason: 'Already completed; pass restart to run it again' };
		}
		await ctx.scheduler.runAfter(
			0,
			internal.migrations['0052_project_open_commitments'].projectPage,
			{ cursor: begun.cursor ?? null, chain: true, generation: begun.generation }
		);
		logInfo('migration.0052_project_open_commitments.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
			pageCount: begun.pageCount,
		});
		return { started: true, generation: begun.generation };
	},
});
