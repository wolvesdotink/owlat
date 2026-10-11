/**
 * Empty what the retired thread summaries left behind (ADR-0072, migration 0067).
 *
 *   npx convex run migrations/0067_empty_retired_summaries:run
 *
 * The thread brief replaced three summary generators, and nothing writes or
 * reads their stores any more (`mail/legacySummaryRows.ts`): Answer mode's
 * catch-up cards (`threadCatchUps`), Today's one-sentence summaries
 * (`todayThreadSummaries`) and the reader strip's `mailThreads.summaryCache`.
 * They retell mail, so they should not outlive their use. This walk deletes
 * the rows and clears the field.
 *
 * STEPPING STONE: the release after this one drops both tables and the field
 * from the schema, and its deploy is rejected while a row or a field is left.
 * Nothing waits on it inside this release: no reader is left.
 *
 * THREE PASSES, one ledger row: `catchUps`, `todaySummaries`, `threads`. The
 * cursor carries its pass as a prefix.
 *
 * DURABLE AND RESUMABLE: progress and completion live in the migration ledger
 * (`migrationRuns` row `0067_empty_retired_summaries`, lib/migrationLedger.ts).
 * Running `run` again on an unfinished walk resumes it; on a finished one it
 * does nothing (`'{"restart":true}'` starts over). Pages are idempotent: a
 * deleted row is gone and a cleared field has nothing left to clear.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { logInfo } from '../lib/runtimeLog';
import {
	beginMigrationRun,
	isCurrentMigrationPage,
	readMigrationRun,
	recordMigrationPage,
} from '../lib/migrationLedger';

export const MIGRATION = '0067_empty_retired_summaries';
/** The release this migration ships in, recorded on its ledger row. */
const INTRODUCED_IN = '0.6.12';

/** Rows per page: a catch-up card or a sentence is small, a thread row is not. */
const ROW_PAGE_SIZE = 200;
const THREAD_PAGE_SIZE = 100;

const PASSES = ['catchUps', 'todaySummaries', 'threads'] as const;
type Pass = (typeof PASSES)[number];

/** The ledger cursor: `<pass>:<convex cursor>`, an empty cursor for a pass's first page. */
export function encodeCursor(pass: Pass, cursor: string | null): string {
	return `${pass}:${cursor ?? ''}`;
}

export function decodeCursor(stored: string | null | undefined): {
	pass: Pass;
	cursor: string | null;
} {
	if (!stored) return { pass: 'catchUps', cursor: null };
	const split = stored.indexOf(':');
	const named = stored.slice(0, split === -1 ? undefined : split);
	const pass = (PASSES as readonly string[]).includes(named) ? (named as Pass) : 'catchUps';
	const cursor = split === -1 ? null : stored.slice(split + 1);
	return { pass, cursor: cursor || null };
}

/** The pass after `pass`, or null after the last one. */
export function nextPass(pass: Pass): Pass | null {
	return PASSES[PASSES.indexOf(pass) + 1] ?? null;
}

type PageOutcome = { continueCursor: string; isDone: boolean; scanned: number; changed: number };

async function deletePage(
	ctx: MutationCtx,
	table: 'threadCatchUps' | 'todayThreadSummaries',
	cursor: string | null
): Promise<PageOutcome> {
	const { page, continueCursor, isDone } = await ctx.db
		.query(table)
		.paginate({ numItems: ROW_PAGE_SIZE, cursor });
	for (const row of page) await ctx.db.delete(row._id);
	return { continueCursor, isDone, scanned: page.length, changed: page.length };
}

async function threadsPage(ctx: MutationCtx, cursor: string | null): Promise<PageOutcome> {
	const { page, continueCursor, isDone } = await ctx.db
		.query('mailThreads')
		.paginate({ numItems: THREAD_PAGE_SIZE, cursor });
	let changed = 0;
	for (const thread of page) {
		if (thread.summaryCache === undefined) continue;
		await ctx.db.patch(thread._id, { summaryCache: undefined });
		changed++;
	}
	return { continueCursor, isDone, scanned: page.length, changed };
}

function pageOf(ctx: MutationCtx, pass: Pass, cursor: string | null): Promise<PageOutcome> {
	switch (pass) {
		case 'catchUps':
			return deletePage(ctx, 'threadCatchUps', cursor);
		case 'todaySummaries':
			return deletePage(ctx, 'todayThreadSummaries', cursor);
		case 'threads':
			return threadsPage(ctx, cursor);
	}
}

/** Run one page of the current pass and schedule the next one of the same run. */
export const processPage = internalMutation({
	args: { cursor: v.union(v.string(), v.null()), generation: v.number() },
	handler: async (ctx, args): Promise<{ isDone: boolean; isSuperseded?: boolean }> => {
		const run = await readMigrationRun(ctx, MIGRATION);
		if (!isCurrentMigrationPage(run, args.generation)) {
			logInfo('migration.0067_empty_retired_summaries.superseded', {
				generation: args.generation,
			});
			return { isDone: false, isSuperseded: true };
		}
		const { pass, cursor } = decodeCursor(args.cursor);
		const result = await pageOf(ctx, pass, cursor);
		const following = result.isDone ? nextPass(pass) : pass;
		const isDone = following === null;
		const next = following
			? encodeCursor(following, result.isDone ? null : result.continueCursor)
			: encodeCursor(pass, result.continueCursor);
		await recordMigrationPage(ctx, run, {
			cursor: next,
			isDone,
			scanned: result.scanned,
			changed: result.changed,
		});
		logInfo('migration.0067_empty_retired_summaries.page', {
			pass,
			scanned: result.scanned,
			changed: result.changed,
			isDone,
			generation: run.generation,
		});
		if (!isDone) {
			await ctx.scheduler.runAfter(
				0,
				internal.migrations['0067_empty_retired_summaries'].processPage,
				{ cursor: next, generation: run.generation }
			);
		}
		return { isDone };
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
			internal.migrations['0067_empty_retired_summaries'].processPage,
			{ cursor: begun.cursor ?? null, generation: begun.generation }
		);
		logInfo('migration.0067_empty_retired_summaries.started', {
			cursor: begun.cursor ?? null,
			generation: begun.generation,
		});
		return { started: true, generation: begun.generation };
	},
});
