/**
 * Return-path capability tables.
 *
 * Split out of `schema/delivery.ts`: the custom-return-path (VERP envelope
 * sender) capability is a TRANSPORT fact, not a per-send delivery fact, and it
 * is read by the routing seam rather than by the Send lifecycle. Spread into
 * `deliveryTables` so the schema shape is unchanged.
 */

import { defineTable } from 'convex/server';
import { v } from 'convex/values';

export const returnPathTables = {
	// Custom return-path (VERP envelope sender) capability, observed per
	// CONFIGURED TRANSPORT. Deployment-scoped, exactly like the transport
	// configuration itself (env-resolved, see lib/sendProviders/transports.ts),
	// so there is deliberately no organizationId here.
	//
	// A row only reaches `supported` from an OBSERVED delivered bounce whose
	// envelope sender still matched the one we set — mirroring the loopback
	// probe in `schema/delivery.ts`, and for the same reason: a relay that ACCEPTS our MAIL FROM
	// and silently rewrites it would otherwise be recorded as comparable, on
	// exactly the deployments this gate exists to protect.
	sendTransportReturnPathProbes: defineTable({
		transportId: v.string(),
		probeId: v.string(),
		status: v.union(
			v.literal('awaiting_delivery'),
			v.literal('supported'),
			v.literal('unsupported')
		),
		reason: v.union(
			v.literal('awaiting_delivery'),
			v.literal('observed_match'),
			v.literal('rewritten_by_relay'),
			v.literal('rejected_by_relay'),
			v.literal('no_bounce_observed')
		),
		sentEnvelopeSender: v.string(),
		observedEnvelopeSender: v.optional(v.string()),
		startedAt: v.number(),
		settledAt: v.optional(v.number()),
		// Probe count for this transport. Drives the retry BACKOFF: each probe
		// deliberately manufactures a bounce on the operator's relay, and a
		// relay's bounce rate is what gets an ESP account suspended, so an
		// unsupported verdict is re-checked 24h → 7d → 30d rather than daily
		// forever. Absent on rows written before the backoff existed.
		attempts: v.optional(v.number()),
		// The verdict this transport last SETTLED on, carried across an open
		// re-probe. Without it a re-probe would reopen the row, resolution would
		// read `unknown`, and a PROVEN relay would stop being VERP-stamped for up
		// to the probe timeout every time the 30d TTL came round — the re-probe
		// periodically switching off the very stamp it exists to confirm.
		lastSettled: v.optional(
			v.object({
				status: v.union(v.literal('supported'), v.literal('unsupported')),
				reason: v.union(
					v.literal('awaiting_delivery'),
					v.literal('observed_match'),
					v.literal('rewritten_by_relay'),
					v.literal('rejected_by_relay'),
					v.literal('no_bounce_observed')
				),
				settledAt: v.number(),
			})
		),
		updatedAt: v.number(),
	})
		.index('by_transport', ['transportId'])
		.index('by_probe_id', ['probeId'])
		// The expiry sweep reads ONLY open probes; the bound belongs in an index,
		// not in a comment about how many transports a deployment ought to have.
		.index('by_status_started_at', ['status', 'startedAt']),
};
