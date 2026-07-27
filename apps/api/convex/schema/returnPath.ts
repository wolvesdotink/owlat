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
import {
	RETURN_PATH_PROBE_REASONS,
	RETURN_PATH_PROBE_STATUSES,
	SETTLED_RETURN_PATH_PROBE_REASONS,
	SETTLED_RETURN_PATH_PROBE_STATUSES,
} from '../lib/sendProviders/returnPathCapability';

/**
 * Table validators DERIVED from the probe state machine in
 * `lib/sendProviders/returnPathCapability`, not re-listed beside it. Hand-copied
 * literal sets are how a status added to the core silently fails to validate at
 * the table — a drift that would surface as a write rejection on the send path.
 */
const probeStatusValidator = v.union(
	...RETURN_PATH_PROBE_STATUSES.map((status) => v.literal(status))
);
const probeReasonValidator = v.union(
	...RETURN_PATH_PROBE_REASONS.map((reason) => v.literal(reason))
);
const settledStatusValidator = v.union(
	...SETTLED_RETURN_PATH_PROBE_STATUSES.map((status) => v.literal(status))
);
const settledReasonValidator = v.union(
	...SETTLED_RETURN_PATH_PROBE_REASONS.map((reason) => v.literal(reason))
);

export const returnPathTables = {
	// Custom return-path (VERP envelope sender) capability, observed per
	// CONFIGURED TRANSPORT. Deployment-scoped, exactly like the transport
	// configuration itself (env-resolved, see lib/sendProviders/transports.ts),
	// so there is deliberately no organizationId here.
	//
	// A row only reaches `supported` from a bounce that actually reached OUR
	// bounce server — mirroring the loopback probe in `schema/delivery.ts`, and
	// for the same reason: a relay that ACCEPTS our MAIL FROM and silently
	// rewrites it would otherwise be recorded as comparable, on exactly the
	// deployments this gate exists to protect. Such a relay sends the DSN
	// somewhere else, so it presents here as silence and ages out unsupported.
	sendTransportReturnPathProbes: defineTable({
		transportId: v.string(),
		probeId: v.string(),
		status: probeStatusValidator,
		reason: probeReasonValidator,
		sentEnvelopeSender: v.string(),
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
				// Both subsets exclude `awaiting_delivery`: that is the status/reason
				// of a probe still in flight, and a SETTLED verdict can never carry it.
				status: settledStatusValidator,
				reason: settledReasonValidator,
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
