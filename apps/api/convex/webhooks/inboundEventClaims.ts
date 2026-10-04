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
 *
 * EXCLUSIVE FOR AS LONG AS IT IS HELD:
 *  - each claim carries an ownership `token`, and `complete` / `release` act
 *    only for the holder of the current one, so a worker whose claim was taken
 *    over cannot complete or delete its successor's;
 *  - expiry never removes an in-flight claim inside its lease, and a completed
 *    claim outlives the last moment a copy of its event can still be presented
 *    (see `expiresAtFor`), so a copy parsed before the window closed and
 *    dispatched after it still finds the claim.
 */

import { v } from 'convex/values';
import { nanoid } from 'nanoid';
import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { ActionCtx, MutationCtx } from '../_generated/server';
import { internalMutation } from '../lib/writeFence';
import { logError, logWarn } from '../lib/runtimeLog';
import { INBOUND_REPLAY_WINDOW_MS } from './types';

/** Expired rows examined per claim; the hourly cron empties the rest. */
const EXPIRED_SWEEP_LIMIT = 32;

/** Rows examined per cleanup run before it reschedules itself. */
const CLEANUP_BATCH_SIZE = 200;

/**
 * How long an in-flight claim blocks a second copy before it may be taken over.
 *
 * It has to outlast the ACTION holding it, or a takeover could steal a claim
 * from a handler that is still running and apply the event twice. Webhook
 * routes are HTTP actions in Convex's V8 runtime, which lets user code run for
 * up to 30 minutes (`V8_ACTION_USER_TIMEOUT`, 1800 s); five minutes on top
 * cover clock skew between the two mutations. The cost of a crashed holder is
 * bounded too: Mandrill re-posts every 15–25 minutes, so at most two of its 20
 * attempts are answered retryably before the claim can be taken over.
 */
export const IN_FLIGHT_LEASE_MS = 35 * 60 * 1000;

/**
 * When a claim may be swept. An adapter stamps a key only while its event is
 * younger than `INBOUND_REPLAY_WINDOW_MS`, and the action that parsed it
 * dispatches it within one lease, so no copy of the event can still present the
 * key after `eventAt + window + lease`. Until then a completed claim must stay,
 * or a copy parsed just before the window closed would find nothing and apply
 * the event again.
 */
function expiresAtFor(eventAt: number): number {
	return eventAt + INBOUND_REPLAY_WINDOW_MS + IN_FLIGHT_LEASE_MS;
}

/** Whether a row may be deleted: past its expiry and not held by a live run. */
function isSweepable(row: Doc<'inboundEventClaims'>, now: number): boolean {
	if (row.expiresAt > now) return false;
	return row.status === 'completed' || row.claimedAt <= now - IN_FLIGHT_LEASE_MS;
}

/**
 * - `claimed`: the caller owns the key under `token` and must `complete` or
 *   `release` it with that token.
 * - `duplicate_in_flight`: another copy is being applied right now; answer
 *   retryably.
 * - `duplicate_completed`: already applied; acknowledge and do nothing.
 */
export type InboundEventClaimResult =
	| { result: 'claimed'; token: string }
	| { result: 'duplicate_in_flight' }
	| { result: 'duplicate_completed' };

export const claim = internalMutation({
	args: { replayKey: v.string(), eventAt: v.number() },
	handler: async (ctx, args): Promise<InboundEventClaimResult> => {
		const now = Date.now();
		const expired = await ctx.db
			.query('inboundEventClaims')
			.withIndex('by_expires_at', (q) => q.lte('expiresAt', now))
			.take(EXPIRED_SWEEP_LIMIT);
		for (const row of expired) if (isSweepable(row, now)) await ctx.db.delete(row._id);

		const token = nanoid();
		const existing = await ctx.db
			.query('inboundEventClaims')
			.withIndex('by_replay_key', (q) => q.eq('replayKey', args.replayKey))
			.first();
		if (existing && !isSweepable(existing, now)) {
			if (existing.status === 'completed') return { result: 'duplicate_completed' };
			if (existing.claimedAt > now - IN_FLIGHT_LEASE_MS) return { result: 'duplicate_in_flight' };
			// The run holding it outlived any action's lifetime without releasing
			// it: take the claim over under a new token, so that run can no longer
			// complete or release it.
			await ctx.db.patch(existing._id, { claimedAt: now, token });
			return { result: 'claimed', token };
		}
		if (existing) await ctx.db.delete(existing._id);

		await ctx.db.insert('inboundEventClaims', {
			replayKey: args.replayKey,
			token,
			eventAt: args.eventAt,
			claimedAt: now,
			expiresAt: expiresAtFor(args.eventAt),
			status: 'in_flight',
		});
		return { result: 'claimed', token };
	},
});

/** The current claim on `replayKey`, if `token` still owns it. */
async function ownedClaim(
	ctx: MutationCtx,
	args: { replayKey: string; token: string }
): Promise<Doc<'inboundEventClaims'> | null> {
	const existing = await ctx.db
		.query('inboundEventClaims')
		.withIndex('by_replay_key', (q) => q.eq('replayKey', args.replayKey))
		.first();
	return existing && existing.token === args.token ? existing : null;
}

/** Mark a claimed event applied. A claim swept or taken over is left alone. */
export const complete = internalMutation({
	args: { replayKey: v.string(), token: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const owned = await ownedClaim(ctx, args);
		if (owned) await ctx.db.patch(owned._id, { status: 'completed', completedAt: Date.now() });
	},
});

/** Give back an in-flight claim whose handler threw. Never a completed one. */
export const release = internalMutation({
	args: { replayKey: v.string(), token: v.string() },
	handler: async (ctx, args): Promise<void> => {
		const owned = await ownedClaim(ctx, args);
		if (owned && owned.status !== 'completed') await ctx.db.delete(owned._id);
	},
});

/**
 * Cron: delete expired claims. The claim hot path sweeps too, but only while
 * events keep arriving; this empties what a quiet provider leaves behind.
 */
export const cleanupExpired = internalMutation({
	args: {},
	handler: async (ctx) => {
		const now = Date.now();
		const expired = await ctx.db
			.query('inboundEventClaims')
			.withIndex('by_expires_at', (q) => q.lte('expiresAt', now))
			.take(CLEANUP_BATCH_SIZE);
		const sweepable = expired.filter((row) => isSweepable(row, now));
		for (const row of sweepable) await ctx.db.delete(row._id);
		// Rows still held by a live run stay; they become sweepable within a lease.
		if (expired.length === CLEANUP_BATCH_SIZE && sweepable.length > 0) {
			await ctx.scheduler.runAfter(0, internal.webhooks.inboundEventClaims.cleanupExpired, {});
		}
		return { deletedCount: sweepable.length };
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
	const claimed: InboundEventClaimResult = await ctx.runMutation(
		internal.webhooks.inboundEventClaims.claim,
		guard
	);
	if (claimed.result === 'duplicate_completed') {
		logWarn(`[Webhook Dispatcher] replayed provider event ignored (${guard.replayKey})`);
		return undefined;
	}
	if (claimed.result === 'duplicate_in_flight') throw new InboundEventInFlightError();
	const owner = { replayKey: guard.replayKey, token: claimed.token };

	let result: T;
	try {
		result = await apply();
	} catch (err) {
		try {
			await ctx.runMutation(internal.webhooks.inboundEventClaims.release, owner);
		} catch (releaseErr) {
			logError('[Webhook Dispatcher] failed to release a provider event claim:', releaseErr);
		}
		throw err;
	}
	try {
		await ctx.runMutation(internal.webhooks.inboundEventClaims.complete, owner);
	} catch (completeErr) {
		logError('[Webhook Dispatcher] failed to complete a provider event claim:', completeErr);
	}
	return result;
}
