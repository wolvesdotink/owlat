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

export const claim = internalMutation({
	args: {
		pluginId: v.string(),
		transportKind: v.string(),
		deliveryDigest: v.string(),
		expiresAt: v.number(),
	},
	handler: async (ctx, args): Promise<boolean> => {
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
		if (existing && existing.expiresAt > now) return false;
		if (existing) await ctx.db.delete(existing._id);

		await ctx.db.insert('pluginWebhookDeliveries', {
			pluginId: args.pluginId,
			transportKind: args.transportKind,
			deliveryDigest: args.deliveryDigest,
			claimedAt: now,
			expiresAt: args.expiresAt,
		});
		return true;
	},
});

/**
 * Give a claim back after a delivery that did not complete — a body the adapter
 * could not parse, a dispatch that threw. Without this, our own failure would
 * turn the provider's legitimate redelivery into a rejected "replay" and the
 * feedback would be lost for good.
 */
export const release = internalMutation({
	args: { deliveryDigest: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const existing = await ctx.db
			.query('pluginWebhookDeliveries')
			.withIndex('by_delivery_digest', (q) => q.eq('deliveryDigest', args.deliveryDigest))
			.first();
		if (existing) await ctx.db.delete(existing._id);
	},
});
