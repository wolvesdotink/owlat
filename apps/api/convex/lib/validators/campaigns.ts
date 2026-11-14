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
 * - `statsSendTime{Optimized,Holdout}{Delivered,Opened,Clicked}`: the same
 *   delivered / reader-opened / reader-clicked counts split by the send-time
 *   optimization arm (`emailSends.sendTimeGroup`), for the report's
 *   comparison. Zero unless the campaign was optimized.
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
	'statsSendTimeOptimizedDelivered',
	'statsSendTimeOptimizedOpened',
	'statsSendTimeOptimizedClicked',
	'statsSendTimeHoldoutDelivered',
	'statsSendTimeHoldoutOpened',
	'statsSendTimeHoldoutClicked',
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

/**
 * Why a scheduled campaign did not start at its time, kept on the campaign
 * after it fell back to draft so the editor can say so in place. The reason
 * and key are the pre-flight's own (`campaigns/refusalCopy.ts`), stored as
 * strings: a refusal written by one build must still load after a later build
 * renames or retires a reason, and the client falls back to `message`.
 */
export const campaignStartRefusalValidator = v.object({
	reason: v.string(),
	messageKey: v.string(),
	messageParams: v.optional(v.record(v.string(), v.union(v.string(), v.number()))),
	/** English, for API consumers and the fallback when the key is unknown. */
	message: v.string(),
	/** The start that did not happen. */
	scheduledAt: v.number(),
	/** When the start was given up. */
	refusedAt: v.number(),
});

/**
 * A scheduled start the start gate is holding (`campaigns/startGate.ts`): the
 * campaign is past its time, still `scheduled`, and waiting for delivery to
 * come back. Kept on the campaign so its pages can say why it has not started
 * and when the wait gives up. `reason` is the pre-flight reason or
 * `delivery_on_hold`, stored as a string like the refusal's, so a hold
 * written by one build still loads under another. Cleared by every lifecycle
 * transition.
 */
export const campaignStartHoldValidator = v.object({
	reason: v.string(),
	/** The start being held; a reschedule makes it stale. */
	scheduledAt: v.number(),
	/** When the gate stops waiting and returns the campaign to draft. */
	givesUpAt: v.number(),
});
