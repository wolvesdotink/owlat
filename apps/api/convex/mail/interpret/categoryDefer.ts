/**
 * A run waiting for the category refinement (PR review PR-4 and its review
 * F1). `settleCategory` (`eligibility.ts`) makes a bulk-stranger candidate's
 * run wait while its thread's category is still provisional; the run then
 * calls {@link deferForCategory} to wait for the settle.
 *
 * The deferral is recorded on the source's snapshot row
 * (`interpretSources.categoryDeferredUntil`) in the same transaction that
 * schedules the ceiling job, so a repeated or concurrent call for the same
 * source and deadline is a no-op: one deferred job per source, never two runs
 * racing past the extraction dedupe. The source stays outstanding meanwhile
 * (no outcome was recorded), which is what it is.
 *
 * Two ways the wait ends, whichever comes first. Both clear
 * `categoryDeferredUntil` and schedule the run in the same transaction, so the
 * other one finds nothing to do:
 *
 *   - the WAKE: a settled category is written for the thread (the model's
 *     refinement, a concrete heuristic label, an owner override) and
 *     {@link wakeCategoryDeferredRuns} runs the waiting sources now;
 *   - the CEILING: {@link settleAtCeiling}, scheduled at the settle time, runs
 *     the source only while it still waits for that deadline. After it the
 *     thread's label is final, whatever it is.
 */

import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { interpretationSourceValidator } from '../../lib/validators/threadBrief';
import { isProvisionalCategory } from './eligibility';
import { loadInterpretSource } from './sources';

/**
 * Newest sources of a thread a wake looks at. A waiting source was captured
 * less than the settle time ago, so it is among the newest; one beyond the
 * bound still runs at its ceiling.
 */
const CATEGORY_WAKE_SCAN = 25;

export const deferForCategory = internalMutation({
	args: { source: interpretationSourceValidator, until: v.number() },
	handler: async (ctx, args): Promise<{ isScheduled: boolean }> => {
		const row = await loadInterpretSource(ctx, args.source);
		if (!row) return { isScheduled: false };
		// Already waiting for this (or a later) deadline: the scheduled run covers it.
		if (row.categoryDeferredUntil !== undefined && row.categoryDeferredUntil >= args.until) {
			return { isScheduled: false };
		}
		// The category settled after the run read it (and its wake found nothing
		// waiting yet): run now rather than wait for the ceiling.
		const thread = row.mailThreadId ? await ctx.db.get(row.mailThreadId) : null;
		if (thread && !isProvisionalCategory(thread.category)) {
			await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
				source: args.source,
			});
			return { isScheduled: true };
		}
		await ctx.db.patch(row._id, { categoryDeferredUntil: args.until, updatedAt: Date.now() });
		await ctx.scheduler.runAt(args.until, internal.mail.interpret.categoryDefer.settleAtCeiling, {
			source: args.source,
			until: args.until,
		});
		return { isScheduled: true };
	},
});

/**
 * The ceiling of a category wait: run the source, unless a wake already did
 * (the deferral is cleared) or a later deferral replaced this one.
 */
export const settleAtCeiling = internalMutation({
	args: { source: interpretationSourceValidator, until: v.number() },
	handler: async (ctx, args): Promise<{ isScheduled: boolean }> => {
		const row = await loadInterpretSource(ctx, args.source);
		if (!row || row.categoryDeferredUntil !== args.until) return { isScheduled: false };
		await ctx.db.patch(row._id, { categoryDeferredUntil: undefined, updatedAt: Date.now() });
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
			source: args.source,
		});
		return { isScheduled: true };
	},
});

/**
 * The wake: `category` was just written for the thread. When it is settled,
 * every source still waiting for it runs now instead of at its ceiling.
 * `previous` is the label it replaced: a run only ever waits while the label
 * is provisional, so replacing a settled label wakes nothing and reads nothing.
 * Returns how many runs it scheduled.
 */
export async function wakeCategoryDeferredRuns(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	category: { label: string; source: string },
	previous: { label: string; source: string } | undefined
): Promise<number> {
	if (isProvisionalCategory(category) || !isProvisionalCategory(previous)) return 0;
	const now = Date.now();
	const newest = await ctx.db
		.query('interpretSources')
		.withIndex('by_mail_thread', (q) => q.eq('mailThreadId', threadId))
		.order('desc')
		.take(CATEGORY_WAKE_SCAN);
	let woken = 0;
	for (const row of newest) {
		// A deadline already past is its ceiling job's (or a legacy job's) to run.
		if (row.categoryDeferredUntil === undefined || row.categoryDeferredUntil <= now) continue;
		await ctx.db.patch(row._id, { categoryDeferredUntil: undefined, updatedAt: now });
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
			source: row.source,
		});
		woken += 1;
	}
	return woken;
}
