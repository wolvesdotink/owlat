/**
 * The replay half of the bundled-plugin feedback route (D6/P2.2): remembering
 * which signed deliveries have already been accepted.
 *
 * Signature verification proves that whoever sent a request holds the shared
 * secret. It cannot, on its own, prove the request has not been sent before —
 * the same authentic bytes verify every time. Binding a timestamp into the
 * signature (see `plugins/inboundSignature.ts`) bounds how long a captured
 * request stays valid; this table removes what is left of that window by
 * refusing a digest it has already claimed.
 *
 * A CLAIM, not a receipt. It is taken before the events are dispatched and
 * released again if the delivery does not complete, so the provider's own
 * redelivery after a failure of ours is accepted normally. What it forbids is
 * the same signed bytes being APPLIED twice.
 *
 * WHICH IS WHY THE ROW CARRIES A STATE. Because the claim precedes dispatch, a
 * second copy arriving while the first is still running is NOT evidence that
 * anything was applied — and answering it the way a true duplicate is answered
 * loses batches: copy A claims and dispatches slowly, the provider times out and
 * re-posts the identical bytes as copy B, B is told 200, A then fails and gives
 * its claim back — and the provider, having already seen a 2xx, never redelivers.
 * The bounces, complaints and suppressions in that batch are gone for good. So
 * `claim` distinguishes the two cases and the route answers them differently:
 * only a COMPLETED delivery earns the duplicate 200; an in-flight one is answered
 * retryably, so the provider comes back after A has resolved either way.
 */

import { v } from 'convex/values';
import { internalMutation } from '../_generated/server';

/**
 * Expired rows removed per claim. Bounded so the hot path stays O(1)-ish, and
 * enough to hold the table at steady state under traffic: every claim can retire
 * more than one predecessor, and every row expires within the contract's
 * tolerance (at most fifteen minutes).
 *
 * OPPORTUNISTIC, not complete. This sweep only runs when a delivery is
 * authorized, so a plugin that is disabled — or a provider that simply stops
 * sending after a burst — strands whatever the last claim did not reach. The
 * `cleanup plugin webhook replay claims` cron
 * (`webhooks/cleanup.cleanupPluginWebhookDeliveries`) is what makes the table
 * empty out when the route goes idle.
 */
const EXPIRED_SWEEP_LIMIT = 32;

/**
 * What a claim attempt found.
 *
 *  - `claimed`            — nothing held this digest; the caller owns it and must
 *                           either `complete` it or `release` it.
 *  - `duplicate_in_flight`— another copy of the same signed bytes is being
 *                           dispatched right now. Nothing has been applied yet
 *                           and it still might not be, so the caller must answer
 *                           retryably.
 *  - `duplicate_completed`— the batch has already been applied. The caller may
 *                           safely acknowledge it.
 */
export type PluginFeedbackClaimResult = 'claimed' | 'duplicate_in_flight' | 'duplicate_completed';

export const claim = internalMutation({
	args: {
		pluginId: v.string(),
		transportKind: v.string(),
		deliveryDigest: v.string(),
		expiresAt: v.number(),
	},
	handler: async (ctx, args): Promise<PluginFeedbackClaimResult> => {
		const now = Date.now();
		const expired = await ctx.db
			.query('pluginWebhookDeliveries')
			.withIndex('by_expires_at', (q) => q.lte('expiresAt', now))
			.take(EXPIRED_SWEEP_LIMIT);
		for (const row of expired) await ctx.db.delete(row._id);

		const existing = await ctx.db
			.query('pluginWebhookDeliveries')
			.withIndex('by_delivery_digest', (q) => q.eq('deliveryDigest', args.deliveryDigest))
			.first();
		// A row that survived the bounded sweep but is already expired is not a
		// replay: the same digest cannot verify again once its timestamp is outside
		// tolerance, so the only way to see one here is the sweep's limit. Treat it
		// as absent and reuse the row.
		if (existing && existing.expiresAt > now) {
			// A row from before this column existed is read as in-flight: that answer
			// costs at worst one redelivery of an already-applied batch (every lane
			// this route dispatches into is idempotent per event), while the other
			// default costs the whole batch when the first copy goes on to fail.
			return existing.status === 'completed' ? 'duplicate_completed' : 'duplicate_in_flight';
		}
		if (existing) await ctx.db.delete(existing._id);

		await ctx.db.insert('pluginWebhookDeliveries', {
			pluginId: args.pluginId,
			transportKind: args.transportKind,
			deliveryDigest: args.deliveryDigest,
			claimedAt: now,
			expiresAt: args.expiresAt,
			status: 'in_flight',
		});
		return 'claimed';
	},
});

/**
 * Mark a claimed delivery applied, and stamp the channel as alive.
 *
 * TWO WRITES IN ONE TRANSACTION, because they record the same fact — this
 * transport's feedback reached us and was dispatched — and neither is worth
 * having without the other.
 *
 * The claim row keeps its `expiresAt`: a completed claim still ages out with the
 * signature tolerance window, because past that window the same bytes can no
 * longer verify and remembering them buys nothing.
 *
 * The activity row does NOT expire. It is what
 * `delivery.status.getProviderFeedbackStatus` grades a plugin feedback channel
 * by, over a seven-day horizon that no replay claim survives. Monotonic, so an
 * out-of-order completion cannot walk the marker backwards and report a live
 * channel as stale.
 *
 * A claim row that is already gone (swept between dispatch and here) is not an
 * error: the delivery still happened, so the activity stamp is still written.
 */
export const complete = internalMutation({
	args: {
		pluginId: v.string(),
		transportKind: v.string(),
		deliveryDigest: v.string(),
	},
	handler: async (ctx, args): Promise<void> => {
		const now = Date.now();
		const existing = await ctx.db
			.query('pluginWebhookDeliveries')
			.withIndex('by_delivery_digest', (q) => q.eq('deliveryDigest', args.deliveryDigest))
			.first();
		if (existing) await ctx.db.patch(existing._id, { status: 'completed', completedAt: now });

		const activity = await ctx.db
			.query('pluginWebhookFeedbackActivity')
			.withIndex('by_transport_kind', (q) => q.eq('transportKind', args.transportKind))
			.first();
		if (!activity) {
			await ctx.db.insert('pluginWebhookFeedbackActivity', {
				pluginId: args.pluginId,
				transportKind: args.transportKind,
				lastEventAt: now,
			});
			return;
		}
		if (activity.lastEventAt < now) await ctx.db.patch(activity._id, { lastEventAt: now });
	},
});

/**
 * Give a claim back after a delivery that did not complete — a body the adapter
 * could not parse, a dispatch that threw. Without this, our own failure would
 * turn the provider's legitimate redelivery into a rejected "replay" and the
 * feedback would be lost for good.
 *
 * A COMPLETED claim is never given back. Releasing one would invite the provider
 * to redeliver a batch that has already been applied, and — worse — would erase
 * the record that lets the next copy be answered 200 rather than retryably. The
 * route only releases claims it holds in flight; this refuses the other case
 * outright rather than relying on that.
 */
export const release = internalMutation({
	args: { deliveryDigest: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const existing = await ctx.db
			.query('pluginWebhookDeliveries')
			.withIndex('by_delivery_digest', (q) => q.eq('deliveryDigest', args.deliveryDigest))
			.first();
		if (existing && existing.status !== 'completed') await ctx.db.delete(existing._id);
	},
});
