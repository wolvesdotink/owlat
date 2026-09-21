/**
 * Cached segment counts — the cron sweep and the on-write single refresh.
 *
 * Both are cursor-checkpointed walkers, not one-shot counts: a segment's
 * membership is a predicate over the whole live-Contact population, so the
 * tally cannot be computed inside one transaction once that population grows
 * past the Convex per-execution read limit. Each execution scans one budgeted
 * slice, carries the running tally in its own arguments, and reschedules itself
 * until the walk is done — the same shape `segments.countMatchingContacts` uses
 * for the builder preview, minus the action (a cron entry point is a mutation).
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';
import { internal } from '../_generated/api';
import { countLiveMatchesForSegments, evaluateSegmentCount } from '../conditions';
import type { Doc } from '../_generated/dataModel';
import { toPaginationCursor } from '../lib/paginationCursor';

/** Segments whose counts share one live-Contact walk. */
const BATCH_SIZE = 10;

/**
 * Documents one execution of a refresh walk may read — a quarter of the default
 * scan budget, because these walkers are MUTATIONS: everything they read is
 * also their OCC conflict set, so a bite taken out of a contacts table that is
 * being written concurrently is a bite that can lose a retry. Smaller
 * executions trade a few more scheduler hops for a walk that finishes.
 */
const REFRESH_DOCUMENT_BUDGET = 1_000;

/**
 * A batch member's tally so far, plus the filter set the tally was computed
 * from. The walk spans several executions, so the segment it is counting can be
 * edited underneath it; carrying the filters it began with is what lets the
 * final write notice. Keyed on the FILTERS rather than on `updatedAt` because
 * `updatedAt` also moves for a rename, which does not change the count and
 * would strand it until the next tick.
 */
const partialTallyValidator = v.object({
	segmentId: v.id('segments'),
	count: v.number(),
	filtersKey: v.string(),
});

/** The identity of a segment's filter set, for "did this change mid-walk?". */
function filtersKey(segment: Doc<'segments'>): string {
	return JSON.stringify(segment.filters);
}

/**
 * Refresh cached counts for a batch of segments. The cron entry point (every 30
 * minutes) and its own continuation: `cursor` walks the `segments` table a batch
 * at a time, `contactCursor` walks the live Contacts within the current batch,
 * and `partials` carries that batch's running tallies between executions.
 */
export const refreshAllSegmentCounts = internalMutation({
	args: {
		cursor: v.optional(v.string()),
		contactCursor: v.optional(v.string()),
		partials: v.optional(v.array(partialTallyValidator)),
	},
	handler: async (ctx, args) => {
		// The execution's single `.paginate()` goes to `segments`; the Contact walk
		// continues through an explicit index range instead (see liveContactScan).
		const paginationResult = await ctx.db.query('segments').paginate({
			cursor: toPaginationCursor(args.cursor),
			numItems: BATCH_SIZE,
		});
		const batch = paginationResult.page;

		const scheduleNextBatch = async () => {
			if (paginationResult.isDone) return;
			await ctx.scheduler.runAfter(0, internal.segments.countRefresh.refreshAllSegmentCounts, {
				cursor: paginationResult.continueCursor as string,
			});
		};

		if (batch.length === 0) {
			await scheduleNextBatch();
			return;
		}

		// The page is re-read every execution, but the WALK's membership is not: a
		// segment that joined the page mid-walk (created, or pulled in when a hard
		// delete shifted the window) has missed the contacts already behind the
		// cursor, so counting it here would write a real number that is simply too
		// low. On a continuation the carried tallies are the membership; newcomers
		// wait for the next sweep, which starts them at the beginning.
		const carried =
			args.contactCursor === undefined
				? null
				: new Map((args.partials ?? []).map((p) => [p.segmentId as string, p]));
		const members = carried === null ? batch : batch.filter((s) => carried.has(s._id));

		if (members.length === 0) {
			await scheduleNextBatch();
			return;
		}

		const tallies = new Map<string, { count: number; filtersKey: string }>();
		for (const segment of members) {
			const partial = carried?.get(segment._id);
			tallies.set(segment._id, {
				count: partial?.count ?? 0,
				filtersKey: partial?.filtersKey ?? filtersKey(segment),
			});
		}

		const scan = await countLiveMatchesForSegments(
			ctx,
			members.map((s) => ({ segmentId: s._id as string, filters: s.filters })),
			{ cursor: args.contactCursor, documentBudget: REFRESH_DOCUMENT_BUDGET }
		);
		for (const segment of members) {
			const tally = tallies.get(segment._id);
			if (tally) tally.count += scan.counts.get(segment._id as string) ?? 0;
		}

		if (!scan.done) {
			await ctx.scheduler.runAfter(0, internal.segments.countRefresh.refreshAllSegmentCounts, {
				cursor: args.cursor,
				contactCursor: scan.cursor ?? undefined,
				partials: members.map((s) => ({
					segmentId: s._id,
					count: tallies.get(s._id)?.count ?? 0,
					filtersKey: tallies.get(s._id)?.filtersKey ?? filtersKey(s),
				})),
			});
			return;
		}

		const now = Date.now();
		for (const segment of members) {
			const tally = tallies.get(segment._id);
			if (!tally) continue;
			// A segment re-filtered mid-walk scheduled its own refresh against the new
			// filters; writing this tally would replace that fresher count with one
			// computed from the filters the edit retired.
			if (filtersKey(segment) !== tally.filtersKey) continue;
			await ctx.db.patch(segment._id, {
				cachedCount: tally.count,
				cachedCountUpdatedAt: now,
			});
		}

		await scheduleNextBatch();
	},
});

/**
 * Refresh the cached count for a single segment — the fire-and-forget task
 * scheduled after a create/update. Resumes its own walk through `cursor` +
 * `partial` and abandons it if the segment's filters changed since the walk
 * began, so a long walk over the old filters cannot land on top of a newer
 * count.
 */
export const refreshSingleSegmentCount = internalMutation({
	args: {
		segmentId: v.id('segments'),
		cursor: v.optional(v.string()),
		partial: v.optional(v.number()),
		startedFiltersKey: v.optional(v.string()),
	},
	handler: async (ctx, args) => {
		const segment = await ctx.db.get(args.segmentId);
		if (!segment) return;

		const startedFiltersKey = args.startedFiltersKey ?? filtersKey(segment);
		// The edit that superseded this walk scheduled a walk of its own; this one
		// would only write a count for filters that no longer exist.
		if (filtersKey(segment) !== startedFiltersKey) return;

		const scan = await evaluateSegmentCount(ctx, segment.filters, {
			cursor: args.cursor,
			documentBudget: REFRESH_DOCUMENT_BUDGET,
		});
		const total = (args.partial ?? 0) + scan.total;

		if (!scan.done) {
			await ctx.scheduler.runAfter(0, internal.segments.countRefresh.refreshSingleSegmentCount, {
				segmentId: args.segmentId,
				cursor: scan.cursor ?? undefined,
				partial: total,
				startedFiltersKey,
			});
			return;
		}

		await ctx.db.patch(args.segmentId, {
			cachedCount: total,
			cachedCountUpdatedAt: Date.now(),
		});
	},
});
