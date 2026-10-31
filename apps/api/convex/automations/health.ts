/**
 * Automation health (module): the automations list's "last 7 days" column.
 * Per automation, how many runs entered, how many a failed step ended and how
 * many the stalled-run sweep ended, over the current UTC day and the six days
 * before it.
 *
 * Writers record an event in the transaction that causes it: the trigger
 * fanout (`triggers.ts`) an entry, the walker's fail-and-cancel
 * (`stepRunTransitions.ts`) a failure, the stalled-run sweep (`stalledRuns.ts`)
 * a stall. Each bumps a random shard of that UTC day's bucket in
 * `automationHealthDays`, so an import burst does not serialize on one row,
 * and a read sums at most {@link HEALTH_WINDOW_DAYS} x `STAT_SHARD_COUNT` rows
 * per automation; it never scans runs. Lifetime totals (`statsEntered`) cannot
 * stand in for a window, which is why the buckets exist.
 *
 * Freshness: an entry or a failure counts as soon as its transaction commits;
 * a stall counts when the sweep ends the run (the sweep runs every six hours
 * and waits out `STALLED_RUN_GRACE_MS`). The window is computed from the
 * query's own clock, and Convex re-runs a query when its data changes, not
 * when the day turns over, so a list left open across midnight UTC keeps the
 * previous window until one of its automations records an event.
 *
 * Counting starts with the release that added this module. Older runs are not
 * backfilled: a cancelled run written before it does not say whether it
 * failed, stalled or was cancelled for another reason.
 */

import { v } from 'convex/values';
import type { DatabaseReader, MutationCtx } from '../_generated/server';
import type { Doc, Id } from '../_generated/dataModel';
import { internal } from '../_generated/api';
import { internalMutation } from '../lib/writeFence';
import { bumpStatShard, sumStatShards } from '../lib/statShards';
import { utcDayKey, utcDayStart } from '../lib/clock';
import { getLive } from '../lib/softDelete';
import { throwInvalidInput } from '../_utils/errors';
import { automationsQuery } from './_helpers';

/** The window the list reports: today (UTC) and the six days before it. */
export const HEALTH_WINDOW_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Buckets older than this are deleted; a margin past the window, never read. */
const HEALTH_RETENTION_DAYS = 14;

/** Bucket rows one prune transaction deletes before it schedules the next. */
const PRUNE_PAGE = 500;

/** Automations one `summaries` call answers for: the list's first page. */
export const MAX_HEALTH_SUMMARY_IDS = 100;

export type AutomationHealthEvent = 'entered' | 'failed' | 'stalled';

const FIELDS: readonly AutomationHealthEvent[] = ['entered', 'failed', 'stalled'];

export type AutomationHealthCounts = Record<AutomationHealthEvent, number>;

/** Start of the window that contains `now`: midnight UTC six days before today. */
export function healthWindowStart(now: number): number {
	return utcDayStart(now) - (HEALTH_WINDOW_DAYS - 1) * DAY_MS;
}

/** Count one health event for an automation on the UTC day of `now`. */
export async function recordAutomationHealth(
	ctx: MutationCtx,
	automationId: Id<'automations'>,
	event: AutomationHealthEvent,
	now: number = Date.now()
): Promise<void> {
	const day = utcDayKey(now);
	await bumpStatShard<AutomationHealthEvent, Doc<'automationHealthDays'>>(
		{
			fields: FIELDS,
			findShard: (shardKey) =>
				ctx.db
					.query('automationHealthDays')
					.withIndex('by_automation_day_shard', (q) =>
						q.eq('automationId', automationId).eq('day', day).eq('shardKey', shardKey)
					)
					.unique(),
			patchShard: (shard, patch) => ctx.db.patch(shard._id, patch),
			insertShard: (shardKey, deltas) =>
				ctx.db.insert('automationHealthDays', { automationId, day, shardKey, ...deltas }),
		},
		{ [event]: 1 }
	);
}

/** An automation's counts over the window that contains `now`. */
export async function summarizeAutomationHealth(
	db: DatabaseReader,
	automationId: Id<'automations'>,
	now: number
): Promise<AutomationHealthCounts> {
	const rows = await db
		.query('automationHealthDays')
		.withIndex('by_automation_day_shard', (q) =>
			q
				.eq('automationId', automationId)
				.gte('day', utcDayKey(healthWindowStart(now)))
				.lte('day', utcDayKey(now))
		)
		.collect(); // bounded: one row per shard per day, at most HEALTH_WINDOW_DAYS x STAT_SHARD_COUNT

	return sumStatShards(FIELDS, rows);
}

/**
 * The last-7-days counts of the given automations, in the order asked. An
 * automation that does not exist or is in Recently deleted is left out, as for
 * an unknown id. Any member who can list automations can read this.
 */
// all-members: aggregate run counts beside the automation list, which every
// member can read (`automations.list`); no contact or message data.
export const summaries = automationsQuery({
	args: { automationIds: v.array(v.id('automations')) },
	handler: async (ctx, args) => {
		if (args.automationIds.length > MAX_HEALTH_SUMMARY_IDS) {
			throwInvalidInput(`At most ${MAX_HEALTH_SUMMARY_IDS} automations per request`);
		}
		const now = Date.now();
		const ids = [...new Set(args.automationIds)];
		const rows = await Promise.all(
			ids.map(async (automationId) => {
				if (!(await getLive(ctx, automationId))) return null;
				return { automationId, ...(await summarizeAutomationHealth(ctx.db, automationId, now)) };
			})
		);
		return rows.filter((row) => row !== null);
	},
});

/**
 * Cron: delete buckets older than the retention, a page at a time. Buckets of
 * a purged automation age out the same way.
 */
export const pruneHealthDays = internalMutation({
	args: {},
	handler: async (ctx): Promise<number> => {
		const cutoff = utcDayKey(utcDayStart(Date.now()) - HEALTH_RETENTION_DAYS * DAY_MS);
		const rows = await ctx.db
			.query('automationHealthDays')
			.withIndex('by_day', (q) => q.lt('day', cutoff))
			.take(PRUNE_PAGE);
		for (const row of rows) await ctx.db.delete(row._id);
		if (rows.length === PRUNE_PAGE) {
			await ctx.scheduler.runAfter(0, internal.automations.health.pruneHealthDays, {});
		}
		return rows.length;
	},
});
