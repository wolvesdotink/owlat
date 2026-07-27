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
import { extractDomainOrNull } from '@owlat/shared';
import { normalizeReturnPathDomain } from '@owlat/shared/verp';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import {
	isProbeDue,
	isProbeTimedOut,
	nextProbeAttempts,
	nextProbeState,
	resolveReturnPathCapability,
	settledVerdictOf,
	unresolvableReturnPathCapability,
	type ResolvedReturnPathCapability,
	type ReturnPathProbeState,
	type ReturnPathProbeStatus,
} from '../lib/sendProviders/returnPathCapability';
import { isCustomReturnPathSupported } from '../lib/sendProviders/returnPathCapability';
import {
	returnPathAuthorizesRelay,
	type ReturnPathSpfProof,
} from '../lib/sendProviders/smtp/returnPath';
import { defaultSendTransportId, tryResolveSendTransport } from '../lib/sendProviders/transports';
import type { SendProviderKind } from '../lib/sendProviders/types';
import { parseReturnPathRelaySpfTerms } from '../domains/spf';
import { getOptional } from '../lib/env';
import { probeIdFromMessageId } from './messageIdRouting';

/**
 * The stored row, minus the system fields. Derived from the schema rather than
 * hand-copied, so the table and its only reader cannot drift apart in silence.
 */
type ProbeRow = Omit<Doc<'sendTransportReturnPathProbes'>, '_id' | '_creationTime'>;

function toProbeState(row: ProbeRow): ReturnPathProbeState {
	return {
		status: row.status,
		reason: row.reason,
		sentEnvelopeSender: row.sentEnvelopeSender,
		startedAt: row.startedAt,
		...(row.settledAt === undefined ? {} : { settledAt: row.settledAt }),
		...(row.attempts === undefined ? {} : { attempts: row.attempts }),
		...(row.lastSettled === undefined ? {} : { lastSettled: row.lastSettled }),
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
	// An open probe resolves to whatever the transport last SETTLED on (or to
	// `unknown` when it has settled nothing), and a TIMED-OUT open probe resolves
	// to `unknown` regardless — so no special case is needed here; the expiry is
	// materialized by `expireTimedOutProbes`, never by a write from a read path.
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
 * `attempts` counts CONSECUTIVE probes since the last `supported` verdict and
 * drives the retry backoff, so a relay that will never support us is re-probed
 * monthly rather than daily — while one that has been working keeps the fast
 * first retry for the day it breaks (see `nextProbeAttempts`).
 *
 * The verdict the transport currently stands on is CARRIED onto the reopened
 * row, so a re-probe never revokes the capability it is re-checking.
 */
export const recordProbeSubmission = internalMutation({
	args: {
		transportId: v.string(),
		probeId: v.string(),
		sentEnvelopeSender: v.string(),
		accepted: v.boolean(),
		at: v.number(),
	},
	handler: async (
		ctx,
		args
	): Promise<
		{ ok: false; reason: 'unresolvable_transport' } | { ok: true; status: ReturnPathProbeStatus }
	> => {
		// Reject an id the transport registry cannot parse at the BOUNDARY rather
		// than persisting whatever string arrived — a row keyed by an id nothing
		// resolves is unreadable by every consumer and invisible to the operator.
		if (!tryResolveSendTransport(args.transportId)) {
			return { ok: false as const, reason: 'unresolvable_transport' as const };
		}
		const existing = await ctx.db
			.query('sendTransportReturnPathProbes')
			.withIndex('by_transport', (q) => q.eq('transportId', args.transportId))
			.first();
		const previous = existing ? toProbeState(existing) : null;
		const attempts = nextProbeAttempts(previous);
		// What the transport currently stands on. Carried onto the reopened row so
		// resolution keeps honouring it until THIS probe settles.
		const carried = settledVerdictOf(previous);
		const opened: ReturnPathProbeState = {
			status: 'awaiting_delivery',
			reason: 'awaiting_delivery',
			sentEnvelopeSender: args.sentEnvelopeSender,
			startedAt: args.at,
			attempts,
			...(carried === undefined ? {} : { lastSettled: carried }),
		};
		const state = nextProbeState(opened, {
			kind: 'submitted',
			accepted: args.accepted,
			at: args.at,
		});
		// Only an OPEN row needs the carry: once the row itself is settled, its own
		// status is the verdict and a leftover copy could only ever go stale.
		const carryForward = state.status === 'awaiting_delivery' ? carried : undefined;
		const values = {
			transportId: args.transportId,
			probeId: args.probeId,
			status: state.status,
			reason: state.reason,
			sentEnvelopeSender: state.sentEnvelopeSender,
			startedAt: state.startedAt,
			attempts,
			...(state.settledAt === undefined ? {} : { settledAt: state.settledAt }),
			// Set ONCE, explicitly: `undefined` is how a settled row CLEARS a stale
			// carry on patch, and Convex strips it on insert.
			lastSettled: carryForward,
			updatedAt: args.at,
		};
		// One row per transport: a new probe REPLACES the previous verdict rather
		// than accumulating history, so the table stays bounded by the number of
		// configured transports.
		if (existing) {
			await ctx.db.patch(existing._id, values);
		} else {
			await ctx.db.insert('sendTransportReturnPathProbes', values);
		}
		return { ok: true as const, status: state.status };
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
 * SILENCE rather than as a mismatch, and why neither this mutation nor the
 * event it raises carries an observed address: there is no production source
 * for one that could differ, and a parameter defaulted to the sent address
 * would be a match by construction dressed up as a check.
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
		const state = nextProbeState(current, { kind: 'observed', at: args.at });
		if (state.status === current.status) {
			return { applied: false as const, reason: 'already_settled' as const };
		}
		await ctx.db.patch(row._id, {
			status: state.status,
			reason: state.reason,
			...(state.settledAt === undefined ? {} : { settledAt: state.settledAt }),
			// This probe has now settled: its own status IS the verdict, so drop the
			// verdict it was carrying from the previous round.
			lastSettled: undefined,
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
		// bounded: at most one row per configured send transport, and only those
		// still 'awaiting_delivery' — the index range, not a comment, is the bound.
		let expired = 0;
		for (const row of open) {
			const current = toProbeState(row);
			if (!isProbeTimedOut(current, args.at)) continue;
			const state = nextProbeState(current, { kind: 'expired', at: args.at });
			await ctx.db.patch(row._id, {
				status: state.status,
				reason: state.reason,
				...(state.settledAt === undefined ? {} : { settledAt: state.settledAt }),
				// Settled now — the carried verdict from the previous round is spent.
				lastSettled: undefined,
				updatedAt: args.at,
			});
			expired++;
		}
		return { expired };
	},
});

/**
 * The generated return-path SPF record for `host` on this domain, with the
 * verification result recorded for it.
 *
 * `dnsRecords.mailFrom` and `verificationResults.mailFrom` are positionally
 * aligned by the verifier, so the proof is read at the SAME index as the
 * record — never by "the first verified mailFrom result", which on a domain
 * carrying both an MX and a TXT entry would answer about the wrong record.
 */
function returnPathSpfProof(
	domain: Doc<'domains'> | null,
	host: string
): { generatedSpfValue: string | undefined; proof: ReturnPathSpfProof | undefined } {
	const records = domain?.dnsRecords?.mailFrom ?? [];
	const index = records.findIndex(
		(record) => record.type === 'TXT' && record.hostname?.toLowerCase() === host.toLowerCase()
	);
	if (index < 0) return { generatedSpfValue: undefined, proof: undefined };
	const generated = records[index]?.value;
	const result = domain?.verificationResults?.mailFrom?.[index];
	return {
		generatedSpfValue: generated,
		proof: result
			? {
					verified: result.verified,
					lastChecked: result.lastChecked,
					foundValue: result.foundValue,
				}
			: undefined,
	};
}

/**
 * The return-path host a RELAY send from `fromAddress` may stamp as its VERP
 * envelope sender — or `undefined`, which means "keep the composer's envelope
 * sender", the shipped behaviour (plan G-08, D2, D11).
 *
 * Three conditions, all required, evaluated cheapest-first so an unproven relay
 * costs exactly one indexed read:
 *
 *  1. the transport is PROVEN to honour a custom return path (the probe);
 *  2. the From domain HAS a return-path host — its own `returnPathHost`
 *     override when set, else the deployment-global `MTA_RETURN_PATH_DOMAIN`.
 *     This is the SAME resolution the direct-MX arm performs (the MTA's sender
 *     keys it by the DKIM signing domain), so both arms of a cell present the
 *     same RFC5321.MailFrom domain for the same From domain — which is what
 *     makes their SPF evaluation, DMARC SPF alignment and therefore their
 *     bounce data comparable at all (D11);
 *  3. that host's PUBLISHED SPF authorises this transport — otherwise the
 *     stamp would make the receiver evaluate SPF for the bounce domain against
 *     the relay's IP and fail it, degrading the very arm being measured.
 *
 * Any of them missing is a degraded measurement, never an error (D2).
 */
export async function relayReturnPathHostFor(
	ctx: QueryCtx,
	relayKind: SendProviderKind,
	fromAddress: string | undefined,
	now: number
): Promise<string | undefined> {
	const capability = await returnPathCapabilityFor(ctx, defaultSendTransportId(relayKind), now);
	if (!isCustomReturnPathSupported(capability)) return undefined;

	const fromDomain = fromAddress ? extractDomainOrNull(fromAddress) : null;
	const domain = fromDomain
		? await ctx.db
				.query('domains')
				.withIndex('by_domain', (q) => q.eq('domain', fromDomain.toLowerCase()))
				.first()
		: null;
	const host = normalizeReturnPathDomain(
		domain?.returnPathHost ?? getOptional('MTA_RETURN_PATH_DOMAIN')
	);
	if (!host) return undefined;

	const { generatedSpfValue, proof } = returnPathSpfProof(domain, host);
	return returnPathAuthorizesRelay({
		host,
		relaySpfTerms: parseReturnPathRelaySpfTerms(getOptional('MTA_RETURN_PATH_RELAY_SPF')),
		generatedSpfValue,
		proof,
		now,
	})
		? host
		: undefined;
}
