/**
 * Demo seed entry point — the mutation the `POST /seed/demo` route
 * (`seedDemo/indexHttp.ts`) drives.
 *
 * DEV ONLY, and it stays that way: this seed creates the dummy teammate
 * sign-ins whose passwords are published fixture hashes. A real install that
 * wants demo content uses the sample-data path instead (`sampleData/`,
 * `POST /sample-data/install`), which runs the same loaders minus the
 * accounts/mailboxes and needs no dev mode.
 *
 * Loaders run in topological order based on their declared `dependencies`
 * (see `./pipeline`). Each loader inserts rows tagged with `seedTag: 'demo'`
 * so reset can find them again. Exception: the `accounts` loader writes
 * BetterAuth component rows, which cannot carry the tag — it dedupes by email
 * instead and is only wiped by the full `POST /dev/reset`.
 *
 * Automation runs and their counter shards carry no tag either; a reset
 * removes them with the seeded automation they belong to
 * ({@link removeSeededAutomationRuns}).
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { recordTableRowCounters } from '../lib/rowCounters';
import type { MutationCtx } from '../_generated/server';
import type { Id } from '../_generated/dataModel';
import { deleteAutomationRun } from '../automations/runDeletion';
import { applyLoaders, isRemovableSeedRow, SEEDED_TABLES, type SeedSummary } from './pipeline';

export type { SeedSummary } from './pipeline';

export const runSeedDemo = internalMutation({
	args: {
		reset: v.boolean(),
	},
	handler: async (ctx, { reset }): Promise<SeedSummary> => {
		const summary: SeedSummary = { inserted: {}, skipped: {} };

		if (reset) {
			summary.deleted = {};
			const runs = await removeSeededAutomationRuns(ctx);
			if (runs > 0) summary.deleted['automationRuns'] = runs;
			for (const table of SEEDED_TABLES) {
				const rows = await ctx.db.query(table).collect(); // bounded: dev-only seed table
				let removed = 0;
				for (const row of rows) {
					if (isRemovableSeedRow(row)) {
						await ctx.db.delete(row._id);
						await recordTableRowCounters(ctx, table, row, null);
						removed++;
					}
				}
				if (removed > 0) summary.deleted[table] = removed;
			}
		}

		const { inserted, skipped } = await applyLoaders(ctx);
		summary.inserted = inserted;
		summary.skipped = skipped;
		return summary;
	},
});

/** Step runs one `deleteAutomationRun` call may delete. */
const RUN_DELETION_BATCH = 64;

/**
 * Delete the runs, run counters and health buckets of every seed-tagged
 * automation, before the tagged sweep deletes the automation itself. Without
 * this a reset would leave runs pointing at a deleted automation, and the
 * reseeded automation's list column would start from zero beside them.
 */
async function removeSeededAutomationRuns(ctx: MutationCtx): Promise<number> {
	const automations = await ctx.db.query('automations').collect(); // bounded: dev-only seed table
	let removed = 0;
	for (const automation of automations) {
		if (!isRemovableSeedRow(automation)) continue;
		const automationId: Id<'automations'> = automation._id;
		const runs = await ctx.db
			.query('automationRuns')
			.withIndex('by_automation', (q) => q.eq('automationId', automationId))
			.collect(); // bounded: the seeded runs plus what a dev stack triggered
		for (const run of runs) {
			// Each pass deletes up to a batch of step runs; the run row goes last.
			let progress;
			do {
				progress = await deleteAutomationRun(ctx, run._id, RUN_DELETION_BATCH);
			} while (!progress.isDeleted);
			removed++;
		}
		const shards = await ctx.db
			.query('automationStatShards')
			.withIndex('by_automation_and_shard', (q) => q.eq('automationId', automationId))
			.collect(); // bounded: at most one row per shard
		for (const shard of shards) await ctx.db.delete(shard._id);
		const days = await ctx.db
			.query('automationHealthDays')
			.withIndex('by_automation_day_shard', (q) => q.eq('automationId', automationId))
			.collect(); // bounded: the health window's days times the shard count
		for (const day of days) await ctx.db.delete(day._id);
	}
	return removed;
}
