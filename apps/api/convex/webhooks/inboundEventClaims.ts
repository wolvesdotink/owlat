/**
 * Apply a provider event ONCE when the provider cannot say it is the same event.
 *
 * Mandrill signs a webhook with no timestamp and gives an event no id, so a
 * redelivered batch, or a request someone captured and posts again, verifies
 * every time (#1228). Most of what such an event does is idempotent in the Send
 * lifecycle anyway. What is not is an effect on an ADDRESS: a `reject` mirrored
 * into the blocklist after an operator removed the row, an `unsub` after the
 * contact re-subscribed. The adapter derives an address-free `replayKey` for
 * those events and the dispatcher runs them through {@link dispatchOnce}.
 *
 * THE CLAIM PROTOCOL IS `pluginFeedbackDeliveries`'s, per event instead of per
 * request. A claim is taken before the handler runs, marked `completed` after
 * it returns and released when it throws, so the provider's own redelivery
 * after a failure of ours is applied normally. A second copy that finds a claim
 * still IN FLIGHT is not a duplicate yet (the first copy may still fail and
 * release it), so it fails its batch retryably rather than being acknowledged
 * and lost. A claim left in flight by a run that died without releasing it is
 * taken over once {@link IN_FLIGHT_LEASE_MS} has passed, so one crash cannot
 * hold a key until Mandrill gives up on the batch and disables the webhook.
 */

import { v } from 'convex/values';
import { internal } from '../_generated/api';
import type { ActionCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logError, logWarn } from '../lib/runtimeLog';
import { INBOUND_REPLAY_WINDOW_MS } from './types';

/** Expired rows removed per claim; the hourly cron empties the rest. */
const EXPIRED_SWEEP_LIMIT = 32;

/** Rows deleted per cleanup run before it reschedules itself. */
const CLEANUP_BATCH_SIZE = 200;

/**
 * How long an in-flight claim blocks a second copy. Longer than a Convex action
 * may run, shorter than Mandrill's 15-minute minimum retry interval.
 */
export const IN_FLIGHT_LEASE_MS = 10 * 60 * 1000;

/**
 * - `claimed`: the caller owns the key and must `complete` or `release` it.
 * - `duplicate_in_flight`: another copy is being applied right now; answer
 *   retryably.
 * - `duplicate_completed`: already applied; acknowledge and do nothing.
 */
export type InboundEventClaimResult = 'claimed' | 'duplicate_in_flight' | 'duplicate_completed';

export const claim = internalMutation({
	args: { replayKey: v.string(), eventAt: v.number() },
	handler: async (ctx, args): Promise<InboundEventClaimResult> => {
		const now = Date.now();
		const expired = await ctx.db
			.query('inboundEventClaims')
			.withIndex('by_expires_at', (q) => q.lte('expiresAt', now))
			.take(EXPIRED_SWEEP_LIMIT);
		for (const row of expired) await ctx.db.delete(row._id);

		const existing = await ctx.db
			.query('inboundEventClaims')
			.withIndex('by_replay_key', (q) => q.eq('replayKey', args.replayKey))
			.first();
		if (existing && existing.expiresAt > now) {
			if (existing.status === 'completed') return 'duplicate_completed';
			if (existing.claimedAt > now - IN_FLIGHT_LEASE_MS) return 'duplicate_in_flight';
			// The run holding it died without releasing it: take the claim over.
			await ctx.db.patch(existing._id, { claimedAt: now });
			return 'claimed';
		}
		if (existing) await ctx.db.delete(existing._id);

		await ctx.db.insert('inboundEventClaims', {
			replayKey: args.replayKey,
			eventAt: args.eventAt,
			claimedAt: now,
			expiresAt: args.eventAt + INBOUND_REPLAY_WINDOW_MS,
			status: 'in_flight',
		});
		return 'claimed';
	},
});

/** Mark a claimed event applied. A claim already swept is not an error. */
export const complete = internalMutation({
	args: { replayKey: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const existing = await ctx.db
			.query('inboundEventClaims')
			.withIndex('by_replay_key', (q) => q.eq('replayKey', args.replayKey))
			.first();
		if (existing) {
			await ctx.db.patch(existing._id, { status: 'completed', completedAt: Date.now() });
		}
	},
});

/** Give back an in-flight claim whose handler threw. Never a completed one. */
export const release = internalMutation({
	args: { replayKey: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const existing = await ctx.db
			.query('inboundEventClaims')
			.withIndex('by_replay_key', (q) => q.eq('replayKey', args.replayKey))
			.first();
		if (existing && existing.status !== 'completed') await ctx.db.delete(existing._id);
	},
});

/**
 * Cron: delete expired claims. The claim hot path sweeps too, but only while
 * events keep arriving; this empties what a quiet provider leaves behind.
 */
export const cleanupExpired = internalMutation({
	args: {},
	handler: async (ctx) => {
		const expired = await ctx.db
			.query('inboundEventClaims')
			.withIndex('by_expires_at', (q) => q.lte('expiresAt', Date.now()))
			.take(CLEANUP_BATCH_SIZE);
		for (const row of expired) await ctx.db.delete(row._id);
		if (expired.length === CLEANUP_BATCH_SIZE) {
			await ctx.scheduler.runAfter(0, internal.webhooks.inboundEventClaims.cleanupExpired, {});
		}
		return { deletedCount: expired.length };
	},
});

/** Thrown for a copy whose twin is still being applied; fails the batch retryably. */
export class InboundEventInFlightError extends Error {
	constructor() {
		super('Another copy of this provider event is still being applied');
		this.name = 'InboundEventInFlightError';
	}
}

/**
 * Run `apply` for a keyed event unless that key has already been applied.
 *
 * Returns `undefined` without running it for a completed duplicate. A failed
 * `complete` is logged and swallowed: the event WAS applied, and failing the
 * batch would only make the provider redeliver it.
 */
export async function dispatchOnce<T>(
	ctx: ActionCtx,
	guard: { replayKey: string; eventAt: number },
	apply: () => Promise<T>
): Promise<T | undefined> {
	const outcome: InboundEventClaimResult = await ctx.runMutation(
		internal.webhooks.inboundEventClaims.claim,
		guard
	);
	if (outcome === 'duplicate_completed') {
		logWarn(`[Webhook Dispatcher] replayed provider event ignored (${guard.replayKey})`);
		return undefined;
	}
	if (outcome === 'duplicate_in_flight') throw new InboundEventInFlightError();

	let result: T;
	try {
		result = await apply();
	} catch (err) {
		try {
			await ctx.runMutation(internal.webhooks.inboundEventClaims.release, {
				replayKey: guard.replayKey,
			});
		} catch (releaseErr) {
			logError('[Webhook Dispatcher] failed to release a provider event claim:', releaseErr);
		}
		throw err;
	}
	try {
		await ctx.runMutation(internal.webhooks.inboundEventClaims.complete, {
			replayKey: guard.replayKey,
		});
	} catch (completeErr) {
		logError('[Webhook Dispatcher] failed to complete a provider event claim:', completeErr);
	}
	return result;
}
