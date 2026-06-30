/**
 * Automation run-stat sharding (module).
 *
 * fireTrigger used to read-modify-write the single `automations` row on EVERY
 * contact entry (statsEntered + statsActive), and complete/cancelAutomationRun
 * RMW'd it again — so a bulk-import burst into a `contact_created` automation
 * (matches: () => true) serialized thousands of concurrent RMWs on one row.
 *
 * Each entry/completion/cancellation now bumps a RANDOM shard of
 * `automationStatShards` (inc-only counters — entered / completed / cancelled);
 * a rollup sums the shards into `automations.stats*` (the read interface) and
 * DERIVES statsActive = entered − completed − cancelled. Readers are unchanged.
 * Mirrors campaigns/statShards.ts + the sendingReputation idiom (ADR-0042).
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type DatabaseReader } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { toPaginationCursor } from '../lib/paginationCursor';
import { bumpStatShard, sumStatShards } from '../lib/statShards';

const ROLLUP_PAGE_SIZE = 50;

export type AutomationStatField = 'statsEntered' | 'statsCompleted' | 'statsCancelled';

const FIELDS: readonly AutomationStatField[] = ['statsEntered', 'statsCompleted', 'statsCancelled'];

/**
 * Increment inc-only run-stat counter(s) on a RANDOM shard of an automation,
 * creating the shard row on its first event. Called from fireTrigger (entered),
 * completeAutomationRun (completed), cancelAutomationRun (cancelled).
 */
export async function bumpAutomationStats(
	ctx: MutationCtx,
	automationId: Doc<'automations'>['_id'],
	deltas: Partial<Record<AutomationStatField, number>>,
): Promise<void> {
	await bumpStatShard<AutomationStatField, Doc<'automationStatShards'>>(
		{
			fields: FIELDS,
			findShard: (shardKey) =>
				ctx.db
					.query('automationStatShards')
					.withIndex('by_automation_and_shard', (q) =>
						q.eq('automationId', automationId).eq('shardKey', shardKey),
					)
					.unique(),
			patchShard: (shard, patch) => ctx.db.patch(shard._id, patch),
			insertShard: (shardKey, d) =>
				ctx.db.insert('automationStatShards', { automationId, shardKey, ...d }),
		},
		deltas,
	);
}

export interface AutomationStatsSummary {
	statsEntered: number;
	statsCompleted: number;
	statsCancelled: number;
}

/** Sum an automation's shards. Bounded: ≤ SHARD_COUNT rows. */
export async function summarizeAutomationStats(
	db: DatabaseReader,
	automationId: Doc<'automations'>['_id'],
): Promise<AutomationStatsSummary> {
	const shards = await db
		.query('automationStatShards')
		.withIndex('by_automation_and_shard', (q) => q.eq('automationId', automationId))
		.collect(); // bounded: ≤ STAT_SHARD_COUNT shard rows per automation

	return sumStatShards(FIELDS, shards);
}

/**
 * Roll an automation's sharded counters into automations.stats* (the read
 * cache), deriving statsActive = entered − completed − cancelled (every running
 * run was entered and is neither completed nor cancelled). Skips the write when
 * nothing changed.
 */
export async function rollupAutomationStatsRow(
	ctx: MutationCtx,
	automation: Doc<'automations'>,
): Promise<void> {
	const sum = await summarizeAutomationStats(ctx.db, automation._id);
	const statsActive = Math.max(0, sum.statsEntered - sum.statsCompleted - sum.statsCancelled);
	if (
		(automation.statsEntered ?? 0) === sum.statsEntered &&
		(automation.statsCompleted ?? 0) === sum.statsCompleted &&
		(automation.statsActive ?? 0) === statsActive
	) {
		return;
	}
	await ctx.db.patch(automation._id, {
		statsEntered: sum.statsEntered,
		statsCompleted: sum.statsCompleted,
		statsActive,
		updatedAt: Date.now(),
	});
}

/**
 * Cron: roll sharded automation counters into automations.stats* for every
 * non-draft automation (draft ones never received an entry). Paginated with a
 * scheduled continuation; the automations table is per-org and small.
 */
export const rollupAutomationStats = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const page = await ctx.db
			.query('automations')
			.paginate({ cursor: toPaginationCursor(args.cursor), numItems: ROLLUP_PAGE_SIZE });

		for (const automation of page.page) {
			if (automation.status === 'draft') continue;
			await rollupAutomationStatsRow(ctx, automation);
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.automations.statShards.rollupAutomationStats, {
				cursor: page.continueCursor as string,
			});
		}
	},
});
