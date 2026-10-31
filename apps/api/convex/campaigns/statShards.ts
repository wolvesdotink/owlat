/**
 * Campaign send-stat sharding (module).
 *
 * The Send lifecycle's `campaign_stats_*` effects must not read-modify-write the
 * single `campaigns` row on every recipient event (sent/delivered/opened/clicked/
 * bounced): during a blast that serializes ~workpool-parallelism concurrent RMWs
 * on one document, so the whole `transition` mutation OCC-retries on the campaign
 * counter. Each event bumps a RANDOM shard of `campaignStatShards` — different
 * rows, no contention — and a rollup cron sums the shards into `campaigns.stats*`,
 * which is the read interface (stats refresh on the rollup cadence rather than
 * live-per-event). Mirrors the `sendingReputation`
 * shard idiom.
 */

import { v } from 'convex/values';
import type { MutationCtx, DatabaseReader } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { bumpStatShard, sumStatShards } from '../lib/statShards';
import { CAMPAIGN_SHARDED_STAT_FIELDS, type CampaignStatField } from '../lib/validators/campaigns';

/** Window of `sent` campaigns the rollup keeps fresh — opens/clicks taper off
 * within ~2 weeks; later events still accrue in the shards, just not the cache. */
const SENT_ROLLUP_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const ROLLUP_PAGE_SIZE = 50;

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
	deltas: Partial<Record<CampaignStatField, number>>
): Promise<void> {
	await bumpStatShard<CampaignStatField, Doc<'campaignStatShards'>>(
		{
			fields: CAMPAIGN_SHARDED_STAT_FIELDS,
			findShard: (shardKey) =>
				ctx.db
					.query('campaignStatShards')
					.withIndex('by_campaign_and_shard', (q) =>
						q.eq('campaignId', campaignId).eq('shardKey', shardKey)
					)
					.unique(),
			patchShard: (shard, patch) => ctx.db.patch(shard._id, patch),
			insertShard: (shardKey, d) =>
				ctx.db.insert('campaignStatShards', { campaignId, shardKey, ...d }),
		},
		deltas
	);
}

type CampaignStatsSummary = Record<CampaignStatField, number>;

/** Sum a campaign's shards. The reader-side seam that makes the shard split
 * invisible. Bounded: at most SHARD_COUNT rows. */
export async function summarizeCampaignStats(
	db: DatabaseReader,
	campaignId: Doc<'campaigns'>['_id']
): Promise<CampaignStatsSummary> {
	const shards = await db
		.query('campaignStatShards')
		.withIndex('by_campaign_and_shard', (q) => q.eq('campaignId', campaignId))
		.collect(); // bounded: ≤ STAT_SHARD_COUNT shard rows per campaign

	return sumStatShards(CAMPAIGN_SHARDED_STAT_FIELDS, shards);
}

/**
 * Roll a campaign's sharded counters into its `campaigns.stats*` cache (the read
 * interface). Skips the write when nothing changed. Leaves statsUnsubscribed
 * (not sharded) untouched.
 */
export async function rollupCampaignStatsRow(
	ctx: MutationCtx,
	campaign: Doc<'campaigns'>
): Promise<void> {
	const sum = await summarizeCampaignStats(ctx.db, campaign._id);
	if (CAMPAIGN_SHARDED_STAT_FIELDS.every((f) => (campaign[f] ?? 0) === sum[f])) return; // no change
	await ctx.db.patch(campaign._id, { ...sum, statsUpdatedAt: Date.now() });
}

/**
 * Does a rollup cron keep this campaign's cache fresh right now? While one does,
 * the cache trailing its shards is the rollup's cadence, not drift: a `sending`
 * campaign is rolled up by reconcileSendingCampaigns, a recently `sent` one by
 * rollupSentCampaignStats below.
 */
export function isRolledUpOnSchedule(campaign: Doc<'campaigns'>, now: number): boolean {
	if (campaign.status === 'sending') return true;
	return campaign.status === 'sent' && (campaign.sentAt ?? 0) >= now - SENT_ROLLUP_WINDOW_MS;
}

/**
 * Cron: roll up `sent` campaigns within the recent window (the in-flight
 * `sending` campaigns are rolled up by reconcileSendingCampaigns each minute).
 * Paginated with a scheduled continuation so no single transaction processes the
 * whole table.
 */
export const rollupSentCampaignStats = internalMutation({
	args: { cursor: v.optional(v.string()), startedAt: v.optional(v.number()) },
	handler: async (ctx, args) => {
		// Pinned for the whole walk: Convex rejects a cursor whose query (index
		// range included) differs from the one that minted it, so every
		// continuation must read the same bound as the first batch.
		const startedAt = args.startedAt ?? Date.now();
		const cutoff = startedAt - SENT_ROLLUP_WINDOW_MS;
		const page = await ctx.db
			.query('campaigns')
			.withIndex('by_status_sent_at', (q) => q.eq('status', 'sent').gte('sentAt', cutoff))
			.paginate({ cursor: args.cursor ?? null, numItems: ROLLUP_PAGE_SIZE });

		for (const campaign of page.page) {
			await rollupCampaignStatsRow(ctx, campaign);
		}

		if (!page.isDone) {
			await ctx.scheduler.runAfter(0, internal.campaigns.statShards.rollupSentCampaignStats, {
				cursor: page.continueCursor as string,
				startedAt,
			});
		}
	},
});
