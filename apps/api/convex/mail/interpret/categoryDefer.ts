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
 *
 * Every run of the source goes through its lease (`lease.ts`, SPEC §2.5).
 * Recording the wait ends the waiting run's lease. A category that settled
 * between the run's read and its deferral sends the run back to read again,
 * under the lease it still holds, with nothing scheduled. The wake and the
 * ceiling schedule a run that claims the lease like any other; the ceiling
 * first waits out a live lease.
 */

import { v } from 'convex/values';
import { internal } from '../../_generated/api';
import type { Id } from '../../_generated/dataModel';
import type { MutationCtx } from '../../_generated/server';
import { internalMutation } from '../../lib/writeFence';
import { interpretationSourceValidator } from '../../lib/validators/threadBrief';
import { isProvisionalCategory } from './eligibility';
import { loadInterpretSource } from './sources';
import { releaseLeaseIfHeld } from './lease';

/**
 * Sources of a thread one wake transaction reads. The wake walks the thread's
 * whole source range, newest first, in pages of this size, each later page in
 * its own continuation ({@link continueCategoryWake}): neither the number of
 * waiting sources nor newer sources that are not waiting can leave one asleep.
 */
const CATEGORY_WAKE_PAGE = 50;

/** What {@link deferForCategory} answers the run. */
export type CategoryWait =
	| { kind: 'waiting'; until: number }
	/** The category settled after the run read it: read again, under the same lease. */
	| { kind: 'settled' }
	| { kind: 'gone' };

/**
 * Record that the run waits for the category until `until`, and end the
 * run's lease (`lease.ts`) in the same transaction: the wait is its outcome.
 * Nothing is scheduled to run the source but the ceiling (and the wake), so
 * calling this again, from the same or another run, adds no run.
 */
export const deferForCategory = internalMutation({
	args: {
		source: interpretationSourceValidator,
		until: v.number(),
		leaseToken: v.optional(v.string()),
	},
	handler: async (ctx, args): Promise<CategoryWait> => {
		const row = await loadInterpretSource(ctx, args.source);
		if (!row) return { kind: 'gone' };
		// The category settled after the run read it (and its wake found nothing
		// waiting yet): the run reads again itself rather than wait for the ceiling.
		const thread = row.mailThreadId ? await ctx.db.get(row.mailThreadId) : null;
		if (thread && !isProvisionalCategory(thread.category)) return { kind: 'settled' };
		if (args.leaseToken) await releaseLeaseIfHeld(ctx, args.source, args.leaseToken);
		// Already waiting for this (or a later) deadline: the scheduled ceiling covers it.
		if (row.categoryDeferredUntil !== undefined && row.categoryDeferredUntil >= args.until) {
			return { kind: 'waiting', until: row.categoryDeferredUntil };
		}
		await ctx.db.patch(row._id, { categoryDeferredUntil: args.until, updatedAt: Date.now() });
		await ctx.scheduler.runAt(args.until, internal.mail.interpret.categoryDefer.settleAtCeiling, {
			source: args.source,
			until: args.until,
		});
		return { kind: 'waiting', until: args.until };
	},
});

/**
 * The ceiling of a category wait: run the source, unless a wake already did
 * (the deferral is cleared) or a later deferral replaced this one. While a
 * run holds the source's lease, the ceiling comes back when it ends, so it
 * never schedules a run that would only find the source busy.
 */
export const settleAtCeiling = internalMutation({
	args: { source: interpretationSourceValidator, until: v.number() },
	handler: async (ctx, args): Promise<{ isScheduled: boolean }> => {
		const row = await loadInterpretSource(ctx, args.source);
		if (!row || row.categoryDeferredUntil !== args.until) return { isScheduled: false };
		const now = Date.now();
		if (row.leaseToken !== undefined && row.leaseUntil !== undefined && row.leaseUntil > now) {
			await ctx.scheduler.runAt(
				row.leaseUntil,
				internal.mail.interpret.categoryDefer.settleAtCeiling,
				args
			);
			return { isScheduled: false };
		}
		await ctx.db.patch(row._id, { categoryDeferredUntil: undefined, updatedAt: now });
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
 * The first page is woken in the caller's transaction, the rest through
 * continuations. Returns how many runs this transaction scheduled.
 */
export async function wakeCategoryDeferredRuns(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	category: { label: string; source: string },
	previous: { label: string; source: string } | undefined
): Promise<number> {
	if (isProvisionalCategory(category) || !isProvisionalCategory(previous)) return 0;
	return wakePage(ctx, threadId, undefined);
}

/**
 * Where the next page of a wake starts: sources created at or before `at`,
 * minus `seen`, the ones created exactly at `at` that a page already read
 * (creation times can tie, so a strict bound could skip a source).
 */
const wakeCursorValidator = v.object({ at: v.number(), seen: v.array(v.id('interpretSources')) });
type WakeCursor = { at: number; seen: Id<'interpretSources'>[] };

/** A later page of a wake (see {@link wakeCategoryDeferredRuns}). */
export const continueCategoryWake = internalMutation({
	args: { threadId: v.id('mailThreads'), cursor: wakeCursorValidator },
	handler: async (ctx, args): Promise<number> => wakePage(ctx, args.threadId, args.cursor),
});

/**
 * Wake the waiting sources among one page of the thread's sources, newest
 * first from `cursor` (none: the newest), and continue with the next page
 * while the range may hold more. Bounded: one page per transaction. (Not
 * `paginate`, which a function may call only once: this first page runs
 * inside whatever mutation wrote the category.)
 */
async function wakePage(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>,
	cursor: WakeCursor | undefined
): Promise<number> {
	const now = Date.now();
	const seen = new Set(cursor?.seen ?? []);
	const limit = CATEGORY_WAKE_PAGE + seen.size;
	const read = await ctx.db
		.query('interpretSources')
		.withIndex('by_mail_thread', (q) =>
			cursor
				? q.eq('mailThreadId', threadId).lte('_creationTime', cursor.at)
				: q.eq('mailThreadId', threadId)
		)
		.order('desc')
		.take(limit);
	const page = read.filter((row) => !seen.has(row._id)).slice(0, CATEGORY_WAKE_PAGE);
	let woken = 0;
	for (const row of page) {
		// A deadline already past is its ceiling job's (or a legacy job's) to run.
		if (row.categoryDeferredUntil === undefined || row.categoryDeferredUntil <= now) continue;
		await ctx.db.patch(row._id, { categoryDeferredUntil: undefined, updatedAt: now });
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
			source: row.source,
		});
		woken += 1;
	}
	// A full page may have more behind it, whatever the read returned: rows in
	// `seen` that were deleted since make the read short (Sol fixes-r2 F2).
	const last = page[page.length - 1];
	if (page.length === CATEGORY_WAKE_PAGE && last) {
		const at = last._creationTime;
		const tied = page.filter((row) => row._creationTime === at).map((row) => row._id);
		if (cursor?.at === at) tied.push(...seen);
		await ctx.scheduler.runAfter(0, internal.mail.interpret.categoryDefer.continueCategoryWake, {
			threadId,
			cursor: { at, seen: tied },
		});
	}
	return woken;
}

/** Newest inbound messages of a thread whose arrival-depth wait a category write ends. */
const DEPTH_WAKE_RECORDS = 3;

/**
 * Read on arrival (SPEC §2.3.3b): a category was just written for the thread
 * (the refinement, a heuristic label, an owner override). It is the category
 * of the thread's newest inbound message, so that message's run, waiting up
 * to `CATEGORY_DEPTH_WAIT_MS` to decide how deep to read, runs now: the wait
 * marker is cleared and the run scheduled in this same transaction, so the
 * wait's own ceiling run finds nothing to do. Bounded: the newest few records.
 * Returns how many runs were scheduled.
 */
export async function wakeCategoryDepthWaits(
	ctx: MutationCtx,
	threadId: Id<'mailThreads'>
): Promise<number> {
	const records = await ctx.db
		.query('mailArrivalRecords')
		.withIndex('by_thread_source_order', (q) => q.eq('threadId', threadId))
		.order('desc')
		.take(DEPTH_WAKE_RECORDS);
	let woken = 0;
	for (const record of records) {
		const row = await loadInterpretSource(ctx, { kind: 'mail', id: record.messageId });
		if (row?.categoryPendingAt === undefined) continue;
		await ctx.db.patch(row._id, { categoryPendingAt: undefined, updatedAt: Date.now() });
		await ctx.scheduler.runAfter(0, internal.mail.interpret.run.interpretMessage, {
			source: row.source,
		});
		woken += 1;
	}
	return woken;
}
