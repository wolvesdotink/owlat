import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	deliverabilitySignalProviderValidator,
	deliverabilitySignalSeverityValidator,
	deliverabilitySignalSourceValidator,
	deliverabilityStreamValidator,
	destinationProviderValidator,
} from '../delivery/deliverabilityValidators';

/**
 * Deliverability ROUTING tables — the ramp cell's durable state, the MX-learned
 * destination-provider classifier, and the ramp controller's audit trail.
 *
 * Split out of `schema/delivery.ts` (which sits exactly at the 500-LOC ratchet)
 * so the ramp's own tables have somewhere to grow. Pure move for the two
 * existing tables: same fields, same indexes, same names.
 *
 * Spread into `deliveryTables` from schema/delivery.ts.
 */
export const deliverabilityRoutingTables = {
	// Durable provider-slice fallback state materialized from the authenticated
	// MTA snapshot. One row per tenant + destination provider (plus `all`).
	deliverabilityRouteStates: defineTable({
		organizationId: v.string(),
		destinationProvider: deliverabilitySignalProviderValidator,
		// Ramp cell = (stream, destinationProvider). An ABSENT stream is a legacy,
		// stream-less row serving every stream — what the MTA snapshot writes.
		stream: v.optional(deliverabilityStreamValidator),
		// Kept as a derived view of `ownShare`: every reader resolves
		// `ownShare ?? (isFallbackActive ? 0 : 1)` through `resolveOwnShare` in
		// @owlat/shared/deliverabilityRouting.
		isFallbackActive: v.boolean(),
		// Share in [0,1] of the cell carried by the own MTA, absent on every
		// pre-migration row; the ramp phase ceiling (0.25/0.5/0.8/1); the
		// consecutive all-gates-green window count; and the mix generation that
		// salts per-recipient assignment. Written by the ramp controller only.
		ownShare: v.optional(v.number()),
		phaseCeiling: v.optional(v.number()),
		cleanStreak: v.optional(v.number()),
		mixVersion: v.optional(v.number()),
		signals: v.array(
			v.object({
				source: deliverabilitySignalSourceValidator,
				severity: deliverabilitySignalSeverityValidator,
				observedAt: v.number(),
			})
		),
		// Also the AIMD freeze clock / clean-streak clock: no parallel fields.
		// `fallbackActiveSince` is the instant the CURRENT freeze started (what the
		// cooldown ladder's "repeat within 24h" test reads); `healthySince` is the
		// instant the cell last became continuously green (the graduation clock).
		fallbackActiveSince: v.optional(v.number()),
		healthySince: v.optional(v.number()),
		// The freeze's EXPIRY and its LENGTH — the two things a start instant
		// cannot express. `cooldownMs` is the AIMD ladder position (6h, doubling to
		// 48h) the next gate breach doubles from; a fixed hard-stop freeze (breaker
		// 6h, critical blocklist 24h) sets `frozenUntil` and leaves the ladder
		// untouched, so an infrastructure incident cannot inflate a gate cooldown.
		frozenUntil: v.optional(v.number()),
		cooldownMs: v.optional(v.number()),
		// Graduation (plan D9): s = 1.0 held 14 days with every gate green PINS the
		// cell and drops the relay to priority_failover standby. Set once, and
		// cleared only when the share leaves 1.0.
		graduatedAt: v.optional(v.number()),
		snapshotGeneratedAt: v.number(),
		expiresAt: v.number(),
		updatedAt: v.number(),
	})
		.index('by_org_provider', ['organizationId', 'destinationProvider'])
		.index('by_org_provider_stream', ['organizationId', 'destinationProvider', 'stream'])
		.index('by_expires_at', ['expiresAt']),

	// Recipient-domain provider classifications learned from successful MTA
	// deliveries. This lets pre-send routing reuse the MTA's authoritative MX
	// resolution for custom Workspace / Microsoft 365 domains.
	destinationProviderDomains: defineTable({
		organizationId: v.string(),
		domain: v.string(),
		destinationProvider: destinationProviderValidator,
		observedAt: v.number(),
		expiresAt: v.number(),
	})
		.index('by_org_domain', ['organizationId', 'domain'])
		.index('by_expires_at', ['expiresAt']),

	// EVERY ramp-controller evaluation, including the no-ops (plan D12).
	//
	// A controller that silently retreats will be experienced as a bug, so the
	// audit row is not a log line: it is the record that makes a share change
	// explainable after the fact. One row per cell per tick — an hourly cron over
	// at most 15 cells, retention-bounded like every other derived delivery table.
	mixDecisions: defineTable({
		organizationId: v.string(),
		// `${stream}:${destinationProvider}`, the shared canonical cell key. The
		// two axes are ALSO stored separately so a dashboard can filter on one of
		// them without parsing; the key stays the identity.
		cell: v.string(),
		stream: deliverabilityStreamValidator,
		destinationProvider: destinationProviderValidator,
		at: v.number(),
		fromShare: v.number(),
		toShare: v.number(),
		direction: v.union(v.literal('increase'), v.literal('decrease'), v.literal('hold')),
		// The gate aggregate's verdict, or `not_evaluated` when a hard stop or the
		// kill switch decided before any gate was consulted.
		verdict: v.union(
			v.literal('pass'),
			v.literal('fail'),
			v.literal('halt'),
			v.literal('insufficient_data'),
			v.literal('not_evaluated')
		),
		// Stable machine-readable decision reason (a control reason or a gate id).
		reason: v.string(),
		// The same reason as one sentence an operator can act on. The KPI is that
		// 100% of decisions carry one, so it is REQUIRED, not optional.
		message: v.string(),
		failedGate: v.optional(v.string()),
		// THE ADMIN NOTIFICATION for a DECREASE (plan D12): the gate that broke and
		// what to do about it. Present on every decrease and on no other decision,
		// so "what retreated, and why" is one indexed read rather than a scan.
		// Persistent and admin-visible, mirroring `mtaIpReadinessAlerts` — the
		// shipped shape for a delivery incident an operator must see.
		adminNotice: v.optional(v.string()),
		frozenUntil: v.optional(v.number()),
		// JSON snapshot of every gate's inputs and the hard-stop signals, so a
		// decision can be replayed against the pure function that made it. A blob
		// rather than a nested object: it is evidence, never a query predicate.
		snapshot: v.string(),
		expiresAt: v.number(),
	})
		.index('by_cell_time', ['cell', 'at'])
		.index('by_org_cell_time', ['organizationId', 'cell', 'at'])
		.index('by_expires_at', ['expiresAt']),
};
