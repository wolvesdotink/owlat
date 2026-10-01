/**
 * The migration ledger (`migrationRuns`, schema/migrationRuns.ts): durable
 * progress and completion for paged data migrations (CONVENTIONS.md, "Durable
 * progress and completion").
 *
 * A migration calls {@link beginMigrationRun} from its `run` entry point and
 * {@link recordMigrationPage} from each page mutation, in the same transaction
 * as the page's writes. The row then always matches the committed data: its
 * cursor is the position after the last committed page, and `completed` is set
 * by the transaction that committed the final page.
 *
 * Every begin bumps the row's generation. A page is scheduled with the
 * generation it belongs to and checks it with {@link isCurrentMigrationPage}
 * before doing anything, so a resume or restart supersedes a chain that is
 * still queued instead of running beside it.
 */

import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

export type MigrationRun = Doc<'migrationRuns'>;

/** The ledger row of one migration, or null when it has never been started. */
export function readMigrationRun(
	ctx: { db: QueryCtx['db'] },
	migration: string
): Promise<MigrationRun | null> {
	return ctx.db
		.query('migrationRuns')
		.withIndex('by_migration', (q) => q.eq('migration', migration))
		.unique();
}

/**
 * Start a pass, resume an unfinished one, or restart a finished one.
 *
 * - No row, or `restart`: a fresh pass from `cursor` (default: the first row),
 *   with zeroed counts and a new `startedAt`.
 * - A running row: resumes it from `cursor` when given, otherwise from the
 *   stored cursor, keeping its counts and start time.
 * - A completed row without `restart`: nothing changes; returns null.
 *
 * Returns the row as written, whose `generation` the first page must carry.
 */
export async function beginMigrationRun(
	ctx: MutationCtx,
	options: {
		migration: string;
		introducedIn: string;
		cursor?: string | null;
		restart?: boolean;
	}
): Promise<MigrationRun | null> {
	const { migration, introducedIn, restart } = options;
	const existing = await readMigrationRun(ctx, migration);
	const now = Date.now();
	if (existing && existing.status === 'completed' && !restart) return null;

	if (existing && existing.status === 'running' && !restart) {
		const cursor = options.cursor === undefined ? existing.cursor : (options.cursor ?? undefined);
		await ctx.db.patch(existing._id, {
			generation: existing.generation + 1,
			introducedIn,
			cursor,
			updatedAt: now,
		});
		return await ctx.db.get(existing._id);
	}

	const fresh = {
		introducedIn,
		status: 'running' as const,
		generation: (existing?.generation ?? 0) + 1,
		cursor: options.cursor ?? undefined,
		pageCount: 0,
		scannedCount: 0,
		changedCount: 0,
		startedAt: now,
		updatedAt: now,
		completedAt: undefined,
	};
	if (existing) {
		await ctx.db.patch(existing._id, fresh);
		return await ctx.db.get(existing._id);
	}
	const id = await ctx.db.insert('migrationRuns', { migration, ...fresh });
	return await ctx.db.get(id);
}

/**
 * Whether a page scheduled under `generation` still belongs to the run: the
 * row exists, is running, and no begin has superseded that generation.
 */
export function isCurrentMigrationPage(
	run: MigrationRun | null,
	generation: number
): run is MigrationRun {
	return run !== null && run.status === 'running' && run.generation === generation;
}

/**
 * Record one committed page: advance the cursor, add its counts, and mark the
 * run completed when this was the final page. Call it in the page's own
 * transaction, after its writes.
 */
export async function recordMigrationPage(
	ctx: MutationCtx,
	run: MigrationRun,
	page: { cursor: string; isDone: boolean; scanned: number; changed: number }
): Promise<void> {
	const now = Date.now();
	await ctx.db.patch(run._id, {
		cursor: page.cursor,
		pageCount: run.pageCount + 1,
		scannedCount: run.scannedCount + page.scanned,
		changedCount: run.changedCount + page.changed,
		updatedAt: now,
		...(page.isDone ? { status: 'completed' as const, completedAt: now } : {}),
	});
}
