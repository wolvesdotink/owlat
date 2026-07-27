/**
 * Relay return-path capability — persistence + the read seam.
 *
 * The decision logic is pure and lives in
 * `lib/sendProviders/returnPathCapability.ts`; this module is the thin shell
 * that loads the observed probe, calls the pure functions and writes the
 * result. One row per configured transport (deployment-scoped, like the
 * transport configuration itself).
 *
 * Plan D2: everything here is additive. A transport that was never probed, a
 * probe that never came back, a deployment with no relay at all — all resolve
 * to a usable posture with `degraded` measurement. Nothing throws, nothing
 * blocks a send, nothing surfaces an error state.
 */

import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import {
	isProbeDue,
	isProbeTimedOut,
	nextProbeState,
	resolveReturnPathCapability,
	type ResolvedReturnPathCapability,
	type ReturnPathProbeState,
} from '../lib/sendProviders/returnPathCapability';
import { resolveSendTransport, type SendTransportId } from '../lib/sendProviders/transports';

/**
 * Prefix on the message id a return-path probe sends under. The MTA bounce
 * path attributes a DSN by decoding the signed VERP token, so a bounce that
 * carries this id proves the relay preserved our envelope sender byte for byte
 * (any rewrite sends the DSN somewhere we never see). The webhook dispatcher
 * routes these to {@link recordProbeObservation} instead of the Send lifecycle
 * — a probe is not a Send and must never touch a campaign's numbers.
 */
export const RETURN_PATH_PROBE_MESSAGE_ID_PREFIX = 'rp-probe.';

/** The message id a probe sends under. */
export function returnPathProbeMessageId(probeId: string): string {
	return `${RETURN_PATH_PROBE_MESSAGE_ID_PREFIX}${probeId}`;
}

/** Is this attributed message id one of our return-path probes? */
export function isReturnPathProbeMessageId(messageId: string | undefined): boolean {
	return messageId !== undefined && messageId.startsWith(RETURN_PATH_PROBE_MESSAGE_ID_PREFIX);
}

/** The probe id carried by a probe message id, or null. */
export function probeIdFromMessageId(messageId: string): string | null {
	if (!isReturnPathProbeMessageId(messageId)) return null;
	const probeId = messageId.slice(RETURN_PATH_PROBE_MESSAGE_ID_PREFIX.length);
	return probeId.length > 0 ? probeId : null;
}

interface ProbeRow {
	readonly transportId: string;
	readonly probeId: string;
	readonly status: ReturnPathProbeState['status'];
	readonly reason: ReturnPathProbeState['reason'];
	readonly sentEnvelopeSender: string;
	readonly observedEnvelopeSender?: string;
	readonly startedAt: number;
	readonly settledAt?: number;
}

function toProbeState(row: ProbeRow): ReturnPathProbeState {
	return {
		status: row.status,
		reason: row.reason,
		sentEnvelopeSender: row.sentEnvelopeSender,
		...(row.observedEnvelopeSender === undefined
			? {}
			: { observedEnvelopeSender: row.observedEnvelopeSender }),
		startedAt: row.startedAt,
		...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
	};
}

/** Load the stored probe for a transport, as the pure state the core reads. */
async function loadProbeState(
	ctx: QueryCtx,
	transportId: string
): Promise<ReturnPathProbeState | null> {
	const row = await ctx.db
		.query('sendTransportReturnPathProbes')
		.withIndex('by_transport', (q) => q.eq('transportId', transportId))
		.first();
	return row ? toProbeState(row) : null;
}

/**
 * Resolve the transport's kind without letting an unresolvable id become an
 * error surface: an id this deployment no longer configures simply has no
 * capability, which reads as `unknown` (= unsupported, degraded).
 */
function transportKind(
	transportId: string
): ReturnType<typeof resolveSendTransport>['kind'] | null {
	try {
		return resolveSendTransport(transportId as SendTransportId).kind;
	} catch {
		return null;
	}
}

/** The unresolvable/unknown posture. Never an error — plan D2. */
const UNKNOWN_CAPABILITY: ResolvedReturnPathCapability = Object.freeze({
	capability: 'unknown',
	stampVerpReturnPath: false,
	measurement: 'degraded',
	degraded: true,
	bounceToleranceMultiplier: 4,
	declared: 'no',
	probeStatus: 'never_probed',
	reason: 'declared_unsupported',
});

/** Shared resolver used by the query and by callers holding a ctx already. */
export async function returnPathCapabilityFor(
	ctx: QueryCtx,
	transportId: string,
	now: number
): Promise<ResolvedReturnPathCapability> {
	const kind = transportKind(transportId);
	if (!kind) return UNKNOWN_CAPABILITY;
	// An open probe already resolves to `unknown` (= unsupported, degraded), so a
	// timed-out one needs no special case here; the expiry is materialized by
	// `expireTimedOutProbes`, never by a write from a read path.
	const probe = await loadProbeState(ctx, transportId);
	return resolveReturnPathCapability(kind, probe, now);
}

/**
 * The send path's read: may we stamp our VERP envelope sender on this
 * transport, and how comparable is its bounce data?
 */
export const transportReturnPathCapability = internalQuery({
	args: { transportId: v.string() },
	handler: async (ctx, args): Promise<ResolvedReturnPathCapability> =>
		await returnPathCapabilityFor(ctx, args.transportId, Date.now()),
});

/**
 * Is this transport due a (re-)probe? Never probed → yes; supported verdicts
 * are re-checked after the TTL, unsupported ones sooner (relay configuration
 * changes), and an open probe holds the slot until it times out.
 */
export const isReturnPathProbeDue = internalQuery({
	args: { transportId: v.string(), at: v.number() },
	handler: async (ctx, args): Promise<boolean> =>
		isProbeDue(await loadProbeState(ctx, args.transportId), args.at),
});

/**
 * Record that a probe went out (or was refused at MAIL FROM). Acceptance keeps
 * the probe OPEN — it is deliberately not a verdict, because a relay may
 * accept our envelope sender and rewrite it.
 */
export const recordProbeSubmission = internalMutation({
	args: {
		transportId: v.string(),
		probeId: v.string(),
		sentEnvelopeSender: v.string(),
		accepted: v.boolean(),
		at: v.number(),
	},
	handler: async (ctx, args) => {
		const opened: ReturnPathProbeState = {
			status: 'awaiting_delivery',
			reason: 'awaiting_delivery',
			sentEnvelopeSender: args.sentEnvelopeSender,
			startedAt: args.at,
		};
		const state = nextProbeState(opened, {
			kind: 'submitted',
			accepted: args.accepted,
			at: args.at,
		});
		const existing = await ctx.db
			.query('sendTransportReturnPathProbes')
			.withIndex('by_transport', (q) => q.eq('transportId', args.transportId))
			.first();
		const values = {
			transportId: args.transportId,
			probeId: args.probeId,
			status: state.status,
			reason: state.reason,
			sentEnvelopeSender: state.sentEnvelopeSender,
			startedAt: state.startedAt,
			...(state.settledAt === undefined ? {} : { settledAt: state.settledAt }),
			updatedAt: args.at,
		};
		// One row per transport: a new probe REPLACES the previous verdict rather
		// than accumulating history, so the table stays bounded by the number of
		// configured transports.
		if (existing) {
			await ctx.db.patch(existing._id, { ...values, observedEnvelopeSender: undefined });
		} else {
			await ctx.db.insert('sendTransportReturnPathProbes', values);
		}
		return { status: state.status };
	},
});

/**
 * Apply an observed bounce for a probe.
 *
 * `observedEnvelopeSender` is what the bounce was actually addressed to when
 * the caller knows it. When it is omitted the arrival itself is the evidence:
 * the MTA only attributes a DSN whose signed VERP token verifies, which is
 * impossible unless the relay preserved the envelope sender exactly — so the
 * observation is recorded against the address we sent. A caller that DOES see
 * a different address (a relay that rewrote it) records a mismatch and the
 * transport is marked unsupported.
 */
export const recordProbeObservation = internalMutation({
	args: {
		probeMessageId: v.string(),
		observedEnvelopeSender: v.optional(v.string()),
		at: v.number(),
	},
	handler: async (ctx, args) => {
		const probeId = probeIdFromMessageId(args.probeMessageId);
		if (!probeId) return { applied: false as const, reason: 'not_a_probe' as const };
		const row = await ctx.db
			.query('sendTransportReturnPathProbes')
			.withIndex('by_probe_id', (q) => q.eq('probeId', probeId))
			.first();
		if (!row) return { applied: false as const, reason: 'probe_not_found' as const };

		const current = toProbeState(row);
		const state = nextProbeState(current, {
			kind: 'observed',
			envelopeSender: args.observedEnvelopeSender ?? current.sentEnvelopeSender,
			at: args.at,
		});
		if (state === current) return { applied: false as const, reason: 'already_settled' as const };
		await ctx.db.patch(row._id, {
			status: state.status,
			reason: state.reason,
			...(state.observedEnvelopeSender === undefined
				? {}
				: { observedEnvelopeSender: state.observedEnvelopeSender }),
			...(state.settledAt === undefined ? {} : { settledAt: state.settledAt }),
			updatedAt: args.at,
		});
		return { applied: true as const, status: state.status };
	},
});

/**
 * Settle probes that waited past the timeout with nothing observed. Idempotent
 * and bounded by the number of configured transports.
 */
export const expireTimedOutProbes = internalMutation({
	args: { at: v.number() },
	handler: async (ctx, args) => {
		const open = await ctx.db
			.query('sendTransportReturnPathProbes')
			.withIndex('by_transport')
			.collect(); // bounded: one row per configured transport
		let expired = 0;
		for (const row of open) {
			const current = toProbeState(row);
			if (!isProbeTimedOut(current, args.at)) continue;
			const state = nextProbeState(current, { kind: 'expired', at: args.at });
			await ctx.db.patch(row._id, {
				status: state.status,
				reason: state.reason,
				...(state.settledAt === undefined ? {} : { settledAt: state.settledAt }),
				updatedAt: args.at,
			});
			expired++;
		}
		return { expired };
	},
});
