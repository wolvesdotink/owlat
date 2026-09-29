import { v } from 'convex/values';

/**
 * The per-campaign send counters that are write-sharded: each recipient event
 * bumps a random `campaignStatShards` row, and the rollup in
 * `campaigns/statShards.ts` sums the shards into the same-named `campaigns`
 * columns. One list for the two tables and the rollup, so a counter added here
 * is a column on both and is summed; a name missing from the rollup would
 * never reach the campaign row.
 *
 * `statsUnsubscribed` is deliberately not here: it is low frequency, off the
 * hot path, and stays a direct counter on the campaign row.
 *
 * - `statsAutomatedOpened`: sends whose pixel was fetched by an automated
 *   client. The fetch never counts into `statsOpened`; a later reader open of
 *   the same send still does, so the two can overlap. Shown next to the opens.
 *   See `delivery/automatedOpens.ts`.
 * - `statsAutomatedClicked`: sends whose tracked links an automated client
 *   followed. Those requests never count into `statsClicked`; a later reader
 *   click of the same send still does, so the two can overlap. See
 *   `delivery/automatedClicks.ts`.
 */
export const CAMPAIGN_SHARDED_STAT_FIELDS = [
	'statsSent',
	'statsFailed',
	'statsDelivered',
	'statsOpened',
	'statsAutomatedOpened',
	'statsClicked',
	'statsAutomatedClicked',
	'statsBounced',
	'statsHardBounced',
	'statsSoftBounced',
] as const;

export type CampaignStatField = (typeof CAMPAIGN_SHARDED_STAT_FIELDS)[number];

const optionalCount = () => v.optional(v.number());

function optionalCountFields<const K extends string>(
	names: readonly K[]
): Record<K, ReturnType<typeof optionalCount>> {
	return Object.fromEntries(names.map((name) => [name, optionalCount()])) as Record<
		K,
		ReturnType<typeof optionalCount>
	>;
}

/** One optional counter column per sharded stat, for `campaigns` and `campaignStatShards`. */
export const campaignShardedStatFields = optionalCountFields(CAMPAIGN_SHARDED_STAT_FIELDS);
