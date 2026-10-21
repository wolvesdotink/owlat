/**
 * The replay half of the bundled-plugin feedback route: remembering
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
 *
 * HOW LONG A ROW LIVES depends on what its digest names. A digest that covers
 * the signed timestamp (the parameterized HMAC) names one request, which stops
 * verifying with its tolerance window; the row lives exactly that long, in
 * flight or completed. A Svix digest names a MESSAGE (#1367): the sender
 * re-signs every retry with a new timestamp, so the same name keeps arriving
 * for as long as the sender retries. Its claim carries `receiptExpiresAt`, and
 * then the row's `expiresAt` is a lease while in flight and the receipt's end
 * once completed — see `claim` and `complete`.
 */

import { v } from 'convex/values';
import { internalMutation } from '../lib/writeFence';
import { IN_FLIGHT_LEASE_MS } from './inboundEventClaims';

/**
 * Expired rows removed per claim. Bounded so the hot path stays O(1)-ish, and
 * enough to hold the table at steady state under traffic: every claim can retire
 * more than one predecessor, and every row expires — within the contract's
 * tolerance (at most fifteen minutes), or for a Svix receipt within about two
 * days.
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
 *  - `expired`            — the request itself stopped verifying between the
 *                           signature check and this claim. Nothing was read or
 *                           written; the caller must refuse it as the stale
 *                           request it now is.
 */
export type PluginFeedbackClaimResult =
	| 'claimed'
	| 'duplicate_in_flight'
	| 'duplicate_completed'
	| 'expired';

export const claim = internalMutation({
	args: {
		pluginId: v.string(),
		transportKind: v.string(),
		deliveryDigest: v.string(),
		/** When THIS request stops verifying; a claim at or after it is `expired`. */
		expiresAt: v.number(),
		/**
		 * Set when the digest outlives the request (the Svix arm names a message,
		 * not an attempt): how long a COMPLETED receipt must keep answering for it.
		 */
		receiptExpiresAt: v.optional(v.number()),
	},
	handler: async (ctx, args): Promise<PluginFeedbackClaimResult> => {
		const now = Date.now();
		// FIRST, before any receipt is read or swept: is the request still alive?
		// `expiresAt` is no earlier than the first instant its signed timestamp
		// stops verifying (`claimExpiresAtMs` in `plugins/inboundSignature.ts`),
		// and every byte-identical copy of one request carries the same one. A
		// re-signed retry of a Svix message carries its own, later one, and finds a
		// receipt that outlives every attempt's window. The route verifies
		// and then awaits authorization before it gets here, so a replay can verify
		// in the last moment of its window and arrive after it — exactly when its
		// original's receipt has aged out. Refusing it here, in the same
		// transaction that would otherwise claim it, means a claim is only ever
		// taken while any earlier receipt for the same delivery is still live.
		if (now >= args.expiresAt) return 'expired';

		const expired = await ctx.db
			.query('pluginWebhookDeliveries')
			.withIndex('by_expires_at', (q) => q.lte('expiresAt', now))
			.take(EXPIRED_SWEEP_LIMIT);
		for (const row of expired) await ctx.db.delete(row._id);

		const existing = await ctx.db
			.query('pluginWebhookDeliveries')
			.withIndex('by_delivery_digest', (q) => q.eq('deliveryDigest', args.deliveryDigest))
			.first();
		// A row that survived the bounded sweep but is already expired guards
		// nothing any more, so treat it as absent and reuse the slot. For a digest
		// bound to its timestamp, the same request can no longer verify. For a
		// message digest, either the receipt has outlived the sender's retry
		// window, or an in-flight claim outlived its lease — and no action runs
		// that long, so the run that took it has died without releasing it.
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
			expiresAt: inFlightExpiresAt(args, now),
			...(args.receiptExpiresAt === undefined ? {} : { receiptExpiresAt: args.receiptExpiresAt }),
			status: 'in_flight',
		});
		return 'claimed';
	},
});

/**
 * How long an in-flight claim blocks other copies of its delivery.
 *
 * For a digest bound to its timestamp, the request's own window: no other
 * request can present that digest after it, so a longer hold buys nothing.
 *
 * For a message digest, the window is not enough. A re-signed retry carries the
 * same digest with a fresh window, so a claim that lapsed with the FIRST
 * attempt's window could be taken over while that attempt is still
 * dispatching, and the batch applied twice. So it is held for
 * {@link IN_FLIGHT_LEASE_MS}, which outlasts any HTTP action. That is also the
 * most a claim abandoned by a crashed run can cost: a few retries are answered
 * retryably, and the next one after the lease takes the claim over.
 */
function inFlightExpiresAt(
	args: { readonly expiresAt: number; readonly receiptExpiresAt?: number },
	now: number
): number {
	if (args.receiptExpiresAt === undefined) return args.expiresAt;
	return Math.max(args.expiresAt, now + IN_FLIGHT_LEASE_MS);
}

/**
 * Mark a claimed delivery applied, and stamp the channel as alive.
 *
 * TWO WRITES IN ONE TRANSACTION, because they record the same fact — this
 * transport's feedback reached us and was dispatched — and neither is worth
 * having without the other.
 *
 * A completed claim on a digest bound to its timestamp keeps its `expiresAt`:
 * past the signature tolerance window the same bytes can no longer verify, and
 * remembering them buys nothing. A claim that carries `receiptExpiresAt` (a Svix
 * message, #1367) is extended to it here: from now on a re-signed retry of the
 * message is the lost-acknowledgement case, answered 200 and applied nothing.
 * Only the receipt is kept that long, never the in-flight hold, so a run that
 * dies before reaching here blocks the message for one lease, not two days.
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
		if (existing) {
			const { receiptExpiresAt } = existing;
			await ctx.db.patch(existing._id, {
				status: 'completed',
				completedAt: now,
				...(receiptExpiresAt !== undefined && receiptExpiresAt > existing.expiresAt
					? { expiresAt: receiptExpiresAt }
					: {}),
			});
		}

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
