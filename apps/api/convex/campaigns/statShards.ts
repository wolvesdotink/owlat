/**
 * Campaign send-stat sharding (module).
 *
 * The Send lifecycle's `campaign_stats_*` effects used to read-modify-write the
 * single `campaigns` row on every recipient event (sent/delivered/opened/clicked/
 * bounced). During a blast that serialized ~workpool-parallelism concurrent RMWs
 * on one document, so the whole `transition` mutation OCC-retried on the campaign
 * counter. Now each event bumps a RANDOM shard of `campaignStatShards` — different
 * rows, no contention — and a rollup cron sums the shards into `campaigns.stats*`,
 * which stays the read interface (readers are unchanged; stats refresh on the
 * rollup cadence rather than live-per-event). Mirrors the `sendingReputation`
 * shard idiom (ADR-0042).
 */

import { v } from 'convex/values';
import { internalMutation, type MutationCtx, type DatabaseReader } from '../_generated/server';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { toPaginationCursor } from '../lib/paginationCursor';
import { bumpStatShard, sumStatShards } from '../lib/statShards';

/** Window of `sent` campaigns the rollup keeps fresh — opens/clicks taper off
 * within ~2 weeks; later events still accrue in the shards, just not the cache. */
const SENT_ROLLUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const ROLLUP_PAGE_SIZE = 50;

export type CampaignStatField =
	| 'statsSent'
	| 'statsFailed'
	| 'statsDelivered'
	| 'statsOpened'
	| 'statsClicked'
	| 'statsBounced'
	| 'statsHardBounced'
	| 'statsSoftBounced';

const FIELDS: readonly CampaignStatField[] = [
	'statsSent',
	'statsFailed',
	'statsDelivered',
	'statsOpened',
	'statsClicked',
	'statsBounced',
	'statsHardBounced',
	'statsSoftBounced',
];

/**
 * Increment one or more send-stat counters on a RANDOM shard of a campaign,
 * creating the shard row on its first event. The random shard spreads concurrent
 * per-event writes across SHARD_COUNT rows. Called from the Send lifecycle's
 * `campaign_stats_*` effects. (Mutations may use randomness; only the workflow
 * runtime forbids it.)
 */
export async function bumpCampaignStats(
	ctx: MutationCtx,
	campaignId: Doc<'campaigns'>['_id'],
	deltas: Partial<Record<CampaignStatField, number>>,
): Promise<void> {
	await bumpStatShard<CampaignStatField, Doc<'campaignStatShards'>>(
		{
			fields: FIELDS,
			findShard: (shardKey) =>
				ctx.db
					.query('campaignStatShards')
					.withIndex('by_campaign_and_shard', (q) =>
						q.eq('campaignId', campaignId).eq('shardKey', shardKey),
					)
					.unique(),
			patchShard: (shard, patch) => ctx.db.patch(shard._id, patch),
			insertShard: (shardKey, d) =>
				ctx.db.insert('campaignStatShards', { campaignId, shardKey, ...d }),
		},
		deltas,
	);
}

export type CampaignStatsSummary = Record<CampaignStatField, number>;

/** Sum a campaign's shards. The reader-side seam that makes the shard split
 * invisible. Bounded: at most SHARD_COUNT rows. */
export async function summarizeCampaignStats(
	db: DatabaseReader,
	campaignId: Doc<'campaigns'>['_id'],
): Promise<CampaignStatsSummary> {
	const shards = await db
		.query('campaignStatShards')
		.withIndex('by_campaign_and_shard', (q) => q.eq('campaignId', campaignId))
		.collect(); // bounded: ≤ STAT_SHARD_COUNT shard rows per campaign

	return sumStatShards(FIELDS, shards);
}

/**
 * Roll a campaign's sharded counters into its `campaigns.stats*` cache (the read
 * interface). Skips the write when nothing changed. Leaves statsUnsubscribed
 * (not sharded) untouched.
 */
export async function rollupCampaignStatsRow(
	ctx: MutationCtx,
	campaign: Doc<'campaigns'>,
): Promise<void> {
	const sum = await summarizeCampaignStats(ctx.db, campaign._id);
	if (FIELDS.every((f) => (campaign[f] ?? 0) === sum[f])) return; // no change
	await ctx.db.patch(campaign._id, { ...sum, statsUpdatedAt: Date.now() });
}

/**
 * Cron: roll up `sent` campaigns within the recent window (the in-flight
 * `sending` campaigns are rolled up by reconcileSendingCampaigns each minute).
 * Paginated with a scheduled continuation so no single transaction processes the
 * whole table.
 */
export const rollupSentCampaignStats = internalMutation({
	args: { cursor: v.optional(v.string()) },
	handler: async (ctx, args) => {
		const cutoff = Date.now() - SENT_ROLLUP_WINDOW_MS;
		const page = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (q) => q.eq('status', 'sent').gte('sentAt', cutoff))
			.paginate({ cursor: toPaginationCursor(args.cursor), numItems: ROLLUP_PAGE_SIZE });

		for (const campaign of page.page) {
			await rollupCampaignStatsRow(ctx, campaign);
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.campaigns.statShards.rollupSentCampaignStats, {
				cursor: page.continueCursor as string,
			});
		}
	},
});
