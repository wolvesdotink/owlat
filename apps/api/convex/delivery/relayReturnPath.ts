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
	unresolvableReturnPathCapability,
	type ResolvedReturnPathCapability,
	type ReturnPathProbeState,
} from '../lib/sendProviders/returnPathCapability';
import { tryResolveSendTransport } from '../lib/sendProviders/transports';
import { probeIdFromMessageId } from './messageIdRouting';

interface ProbeRow {
	readonly transportId: string;
	readonly probeId: string;
	readonly status: ReturnPathProbeState['status'];
	readonly reason: ReturnPathProbeState['reason'];
	readonly sentEnvelopeSender: string;
	readonly observedEnvelopeSender?: string;
	readonly startedAt: number;
	readonly settledAt?: number;
	readonly attempts?: number;
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
		...(row.attempts === undefined ? {} : { attempts: row.attempts }),
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
 * Shared resolver used by the routing read seam and by callers holding a ctx.
 *
 * An id this deployment no longer configures is not an error surface: it simply
 * has no capability, which reads as `unknown` (= unsupported, degraded).
 */
export async function returnPathCapabilityFor(
	ctx: QueryCtx,
	transportId: string,
	now: number
): Promise<ResolvedReturnPathCapability> {
	const transport = tryResolveSendTransport(transportId);
	if (!transport) return unresolvableReturnPathCapability;
	// An open probe already resolves to `unknown` (= unsupported, degraded), so a
	// timed-out one needs no special case here; the expiry is materialized by
	// `expireTimedOutProbes`, never by a write from a read path.
	const probe = await loadProbeState(ctx, transportId);
	return resolveReturnPathCapability(transport.kind, probe, now);
}

/**
 * Is this transport due a (re-)probe? Never probed → yes; supported verdicts
 * are re-checked after the TTL, unsupported ones on a BACKING-OFF schedule
 * (every probe costs the operator a real bounce), and an open probe holds the
 * slot until it times out.
 *
 * An id that does not resolve is never due — probing it would send nothing.
 */
export const isReturnPathProbeDue = internalQuery({
	args: { transportId: v.string(), at: v.number() },
	handler: async (ctx, args): Promise<boolean> => {
		if (!tryResolveSendTransport(args.transportId)) return false;
		return isProbeDue(await loadProbeState(ctx, args.transportId), args.at);
	},
});

/**
 * Record that a probe went out (or was refused at MAIL FROM). Acceptance keeps
 * the probe OPEN — it is deliberately not a verdict, because a relay may
 * accept our envelope sender and rewrite it.
 *
 * `attempts` accumulates across re-probes and drives the retry backoff, so a
 * relay that will never support us is re-probed monthly rather than daily.
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
		// Reject an id the transport registry cannot parse at the BOUNDARY rather
		// than persisting whatever string arrived — a row keyed by an id nothing
		// resolves is unreadable by every consumer and invisible to the operator.
		if (!tryResolveSendTransport(args.transportId)) {
			return { status: 'unresolvable_transport' as const };
		}
		const existing = await ctx.db
			.query('sendTransportReturnPathProbes')
			.withIndex('by_transport', (q) => q.eq('transportId', args.transportId))
			.first();
		const attempts = (existing?.attempts ?? 0) + 1;
		const opened: ReturnPathProbeState = {
			status: 'awaiting_delivery',
			reason: 'awaiting_delivery',
			sentEnvelopeSender: args.sentEnvelopeSender,
			startedAt: args.at,
			attempts,
		};
		const state = nextProbeState(opened, {
			kind: 'submitted',
			accepted: args.accepted,
			at: args.at,
		});
		const values = {
			transportId: args.transportId,
			probeId: args.probeId,
			status: state.status,
			reason: state.reason,
			sentEnvelopeSender: state.sentEnvelopeSender,
			startedAt: state.startedAt,
			attempts,
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
 * ARRIVAL IS THE EVIDENCE, and it is stronger evidence than an address
 * comparison would be. Our bounce server only attributes a DSN whose signed
 * VERP token verifies, and the MAC covers the base64url-encoded id in the LOCAL
 * PART — so a DSN can only reach this mutation if the relay preserved the
 * envelope sender we set, byte for byte. A relay that rewrites it (or merely
 * case-folds the token) sends the DSN to its own address instead: we see
 * nothing at all, the probe ages out, and `expireTimedOutProbes` settles it
 * `unsupported` / `no_bounce_observed`. That is why a rewrite manifests here as
 * SILENCE rather than as a mismatch, and why this mutation takes no observed
 * address: there is no production source for one that could differ, and an
 * optional parameter defaulted to the sent address would be a match by
 * construction dressed up as a check.
 */
export const recordProbeObservation = internalMutation({
	args: {
		probeMessageId: v.string(),
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
			envelopeSender: current.sentEnvelopeSender,
			at: args.at,
		});
		if (state.status === current.status) {
			return { applied: false as const, reason: 'already_settled' as const };
		}
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
 * Settle probes that waited past the timeout with nothing observed — the case
 * a rewritten envelope sender actually presents as. Idempotent.
 *
 * Range-scanned on `by_status_started_at` rather than collecting the table: the
 * bound must live in an index, not in a comment about how many transports a
 * deployment "should" have.
 */
export const expireTimedOutProbes = internalMutation({
	args: { at: v.optional(v.number()) },
	handler: async (ctx, rawArgs) => {
		const args = { at: rawArgs.at ?? Date.now() };
		const open = await ctx.db
			.query('sendTransportReturnPathProbes')
			.withIndex('by_status_started_at', (q) => q.eq('status', 'awaiting_delivery'))
			.collect();
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
