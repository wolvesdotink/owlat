/**
 * Contact-count reconcile: recount the live contacts in bounded transactions
 * and correct the cached `contactCount` (issue #917).
 *
 * The count used to be one mutation that streamed every live contact. Streaming
 * keeps memory flat but does not reset a transaction's read budget, so a large
 * contact book failed the daily reconcile outright, and every dashboard read on
 * an instance without a cached count did the same scan.
 *
 * ── HOW A RUN COUNTS WITHOUT LOSING A CONCURRENT WRITE ──────────────────────
 * A run is a GENERATION: one `counterScopes` row of kind `contactLiveTotal`
 * (the maintained-count engine, `lib/counters.ts`) plus one `live` bucket. Each
 * step reads one page of `contacts` in creation order, adds that page's live
 * rows to the bucket and advances the scope's cursor and watermark. Every
 * contact insert, soft delete and hard delete moves the same bucket in its own
 * transaction when the row sits at or before the watermark
 * (`contacts/growthCounters.recordContactGrowth`); a row past the watermark is
 * left to the walk. Convex commits serializably, so each live row is counted
 * exactly once whatever the interleaving. The last page and the write of
 * `contactCount` happen in ONE transaction, so the number written is the exact
 * live count at that commit, and the generation's rows are deleted in it too.
 *
 * ── RETRIES, OVERLAPS, INTERRUPTIONS ────────────────────────────────────────
 * Each step carries its generation (the scope row's id) and does nothing when
 * that row is gone, so a step queued by a finished run can never write an older
 * count over a newer one. A start while a run is walking joins it instead of
 * starting another; a run whose steps stopped (a failed step, a redeploy
 * mid-chain) is resumed from its stored cursor once it has been quiet for
 * {@link STALLED_AFTER_MS}. A failed step leaves nothing half-written: its page
 * and cursor commit together or not at all.
 *
 * ── MISSING CACHE ───────────────────────────────────────────────────────────
 * Readers no longer count when the cache is absent: `readContactCount` answers
 * `null` ("pending"), and {@link recoverMissingContactCount} (a 10-minute cron)
 * starts a run, whose finish writes the count.
 */

import { v } from 'convex/values';
import type { MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import {
	applyCounterBackfillPage,
	clearCounterScope,
	creationPosition,
	loadCounterScope,
	startCounterScope,
} from '../lib/counters';
import { readInstanceCounter, writeInstanceCounter } from '../lib/instanceCounters';
import { logInfo } from '../lib/runtimeLog';
import {
	CONTACT_LIVE_BUCKET,
	CONTACT_LIVE_TOTAL_SCOPE,
	contactLiveBuckets,
} from './growthCounters';

/** Contacts read per step. A contact row is small (no bodies), so 1,000 fit easily. */
export const RECONCILE_PAGE_ROWS = 1000;

/**
 * Byte budget per step. A page stops early once it has read this much, so a
 * contact book with unusually large rows still stays far below the 16 MiB
 * per-transaction read limit.
 */
export const RECONCILE_PAGE_BYTES = 4 * 1024 * 1024;

/** A walking generation not stepped for this long is treated as stalled and resumed. */
export const STALLED_AFTER_MS = 30 * 60 * 1000;

export type ReconcileStartOutcome = 'started' | 'running' | 'resumed';

export type ReconcileStepOutcome =
	| { status: 'stale' }
	| { status: 'continued'; counted: number }
	| { status: 'finished'; previous: number | null; actual: number; corrected: boolean };

async function scheduleStep(ctx: MutationCtx, generation: Id<'counterScopes'>): Promise<void> {
	await ctx.scheduler.runAfter(0, internal.contacts.countReconcile.step, { generation });
}

/**
 * Start a reconcile run, or join the one already walking. Idempotent and
 * cheap: two reads when a run is under way.
 */
export async function startContactCountReconcile(
	ctx: MutationCtx,
	now: number = Date.now()
): Promise<ReconcileStartOutcome> {
	const existing = await loadCounterScope(ctx.db, CONTACT_LIVE_TOTAL_SCOPE);
	if (existing && !existing.isReady) {
		if (now - existing.updatedAt < STALLED_AFTER_MS) return 'running';
		// Claim the resume, so a second start in the next minutes joins it.
		await ctx.db.patch(existing._id, { updatedAt: now });
		await scheduleStep(ctx, existing._id);
		return 'resumed';
	}
	// A scope left `ready` means something other than this module finished the
	// walk without writing the count; its tally is stale, so count again.
	if (existing) await clearCounterScope(ctx, CONTACT_LIVE_TOTAL_SCOPE);

	await startCounterScope(ctx, 'contactLiveTotal', undefined);
	const created = await loadCounterScope(ctx.db, CONTACT_LIVE_TOTAL_SCOPE);
	if (created) await scheduleStep(ctx, created._id);
	return 'started';
}

async function readLiveTally(ctx: MutationCtx): Promise<number> {
	const bucket = await ctx.db
		.query('counterBuckets')
		.withIndex('by_scope_and_bucket', (q) =>
			q.eq('scope', CONTACT_LIVE_TOTAL_SCOPE).eq('bucket', CONTACT_LIVE_BUCKET)
		)
		.first(); // bounded: one bucket
	return bucket?.count ?? 0;
}

/**
 * Count one page for generation `generation`. On the last page, write the
 * exact count and delete the generation. Exported, with a page-size override,
 * so tests can interleave writes between pages.
 */
export async function runContactCountReconcileStep(
	ctx: MutationCtx,
	generation: Id<'counterScopes'>,
	pageRows: number = RECONCILE_PAGE_ROWS
): Promise<ReconcileStepOutcome> {
	const state: Doc<'counterScopes'> | null = await loadCounterScope(
		ctx.db,
		CONTACT_LIVE_TOTAL_SCOPE
	);
	if (!state || state._id !== generation || state.isReady) return { status: 'stale' };

	const result = await ctx.db.query('contacts').paginate({
		cursor: state.cursor,
		numItems: pageRows,
		maximumBytesRead: RECONCILE_PAGE_BYTES,
	});
	const items = result.page.map((row) => ({
		position: creationPosition(row),
		buckets: contactLiveBuckets(row),
	}));

	if (!result.isDone) {
		await applyCounterBackfillPage(ctx, state, {
			items,
			continueCursor: result.continueCursor,
			isDone: false,
		});
		await scheduleStep(ctx, generation);
		return { status: 'continued', counted: items.length };
	}

	const pageLive = items.filter((item) => item.buckets.length > 0).length;
	const actual = (await readLiveTally(ctx)) + pageLive;
	const previous = (await readInstanceCounter(ctx.db, 'contacts')).contactCount ?? null;
	const corrected = previous !== actual;
	// Same transaction as the last page: nothing can commit between the count
	// and this write. A missing cache (`previous === null`) is always written.
	if (corrected) await writeInstanceCounter(ctx, 'contacts', { contactCount: actual });
	// State row first, then the single bucket: one call clears the generation.
	await clearCounterScope(ctx, CONTACT_LIVE_TOTAL_SCOPE);
	logInfo('contacts.countReconcile.finished', { previous, actual, corrected });
	return { status: 'finished', previous, actual, corrected };
}

/** One step of a reconcile run; reschedules itself until the walk is done. */
export const step = internalMutation({
	args: { generation: v.id('counterScopes') },
	handler: async (ctx, { generation }) => {
		await runContactCountReconcileStep(ctx, generation);
	},
});

/**
 * Start a run when no contact count is cached (a new or restored instance), so
 * the dashboards' "pending" state resolves without any query counting rows.
 * One read when a count is cached.
 */
export async function recoverMissingContactCount(
	ctx: MutationCtx
): Promise<ReconcileStartOutcome | 'cached'> {
	const { contactCount } = await readInstanceCounter(ctx.db, 'contacts');
	if (contactCount !== undefined) return 'cached';
	return await startContactCountReconcile(ctx);
}

export const recoverMissingCount = internalMutation({
	args: {},
	handler: async (ctx) => {
		await recoverMissingContactCount(ctx);
	},
});
