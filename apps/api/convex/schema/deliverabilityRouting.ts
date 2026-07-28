import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	deliverabilitySignalProviderValidator,
	deliverabilitySignalSeverityValidator,
	deliverabilitySignalSourceValidator,
	deliverabilityStreamValidator,
	destinationProviderValidator,
	rampDecisionReasonValidator,
	rampGateIdValidator,
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
		// consecutive all-gates-green window count; and the mix GENERATION that
		// salts per-recipient assignment. Written by the ramp controller only.
		//
		// `mixVersion` NAMES A GENERATION, NOT A STEP (plan D7). It salts
		// `${contactId}:${campaignId}:${mixVersion}`, so every bump re-shuffles
		// which arm each recipient lands in. It therefore advances only on a
		// deliberate generation change — a phase promotion or an operator action —
		// and NEVER on an ordinary AIMD step, which would otherwise re-randomise
		// the cohort ~20 times during a single ramp and destroy per-contact
		// continuity in a comparison that is still in flight.
		ownShare: v.optional(v.number()),
		phaseCeiling: v.optional(v.number()),
		// WHEN THE CELL ARRIVED AT ITS CURRENT RUNG — the dwell clock the promotion
		// rule reads ("2x the normal dwell time at the current ceiling", plan D3's
		// standalone route). Stamped by `promoteRampPhase` and by nothing else: the
		// hourly AIMD loop moves the SHARE, never the rung, so a tick must not be
		// able to restart a dwell the cell has already served.
		//
		// Absent on a row that reached its rung any other way — seeded, hand-patched,
		// or written before this column existed. Absence must NEVER be permanent
		// though: dwell is one of the four conditions on the standalone promotion
		// route, and for a provider with no external route that is the only route
		// there is, so an anchor nobody ever writes would leave the cell
		// unpromotable for ever with no operator remedy (plan D2). The controller
		// therefore ADOPTS the row's creation instant the first time it manages a
		// row without one — the earliest moment the rung could have been set, so the
		// backfill can only understate the dwell served, never manufacture it.
		phaseCeilingSince: v.optional(v.number()),
		cleanStreak: v.optional(v.number()),
		mixVersion: v.optional(v.number()),
		signals: v.array(
			v.object({
				source: deliverabilitySignalSourceValidator,
				severity: deliverabilitySignalSeverityValidator,
				observedAt: v.number(),
			})
		),
		// THE SHIPPED HYSTERESIS CLOCKS, and they belong to the SNAPSHOT writer
		// alone: `fallbackActiveSince` is when relay fallback started and
		// `healthySince` is when the provider slice became continuously healthy.
		// `applySnapshot` reads and stamps both on the STREAM-LESS row.
		fallbackActiveSince: v.optional(v.number()),
		healthySince: v.optional(v.number()),
		// THE RAMP'S OWN CLOCKS, deliberately NOT the two above. They mean different
		// things on a per-stream row, and one column with two meanings across two row
		// shapes is the objection `decidedAt` is kept clear of. The rows do not
		// collide today only because `applySnapshot` loads the stream-less row — and
		// the day a per-stream snapshot writer lands, sharing the columns would let
		// its hysteresis silently re-arm the ramp's 24h repeat window and double a
		// cooldown off a rung nothing breached.
		//
		// `freezeStartedAt` is the instant the current GATE-COOLDOWN freeze started —
		// the ladder's "repeat within 24h" anchor — and only a ladder freeze
		// re-stamps it, so an infrastructure freeze (breaker, blocklist) cannot
		// re-arm the repeat window and inflate the next gate cooldown. `greenSince`
		// is the instant the cell last became continuously green (the graduation
		// clock).
		freezeStartedAt: v.optional(v.number()),
		greenSince: v.optional(v.number()),
		// The freeze's EXPIRY and its LENGTH — the two things a start instant
		// cannot express. `cooldownMs` is the AIMD ladder position (6h, doubling to
		// 48h) the next gate breach doubles from; a fixed hard-stop freeze (breaker
		// 6h, critical blocklist 24h) sets `frozenUntil` and leaves the ladder
		// untouched, so an infrastructure incident cannot inflate a gate cooldown.
		frozenUntil: v.optional(v.number()),
		cooldownMs: v.optional(v.number()),
		// WHICH RUNG STAMPED `frozenUntil`. Three rungs can freeze a cell and they
		// do not mean the same thing: the circuit-breaker rung charges its halving
		// ONCE per incident and declines to re-charge while ITS OWN freeze runs, so
		// without the origin on the row an unrelated gate cooldown — up to 48h —
		// would absorb the retreat a newly-open breaker is supposed to cost. Absent
		// on a row frozen before this was recorded, and an unattributed freeze is
		// deliberately never read as the breaker's.
		freezeReason: v.optional(
			v.union(v.literal('gate_breach'), v.literal('breaker'), v.literal('dnsbl'))
		),
		// Graduation (plan D9): s = 1.0 held 14 days with every gate green PINS the
		// cell and drops the relay to priority_failover standby. Set once, and
		// cleared only when the share leaves 1.0.
		graduatedAt: v.optional(v.number()),
		// The instant the last COUNTED evaluation window was counted. The cron ticks
		// hourly against a 24h outcome window, so without an anchor K_CLEAN = 3 would
		// be satisfied by three overlapping reads of the SAME day an hour apart. A
		// window counts once, and only a counted window extends the clean streak or
		// unlocks an additive increase.
		lastCountedAt: v.optional(v.number()),
		// THE RAMP'S OWN CLOCK, and the reason it is not `updatedAt`. `updatedAt` is
		// the shipped router's SIGNAL-FRESHNESS clock: `routeInputs.ts` only acts on
		// a row it has heard from within `DELIVERABILITY_SIGNAL_MAX_AGE_MS`, so a
		// snapshot that stopped arriving stops steering traffic. An hourly
		// controller stamping that column would re-arm every signal on the row as
		// "fresh" on every tick, for ever — one column with two meanings across two
		// row shapes, the same objection `snapshotGeneratedAt` is kept clear of.
		decidedAt: v.optional(v.number()),
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
		// Stable machine-readable decision reason (a control reason or a gate id),
		// as the CLOSED union it is in TypeScript rather than a free string: the
		// narrative's exhaustive switch is what guarantees every decision has a
		// sentence, and the stored column has to be able to make the same promise.
		reason: rampDecisionReasonValidator,
		// The same reason as one sentence an operator can act on. The KPI is that
		// 100% of decisions carry one, so it is REQUIRED, not optional.
		message: v.string(),
		failedGate: v.optional(rampGateIdValidator),
		// THE ADMIN NOTIFICATION for a retreat (plan D12): what broke and what to do
		// about it. Present when the decision has a NAMED cause — a breached gate or
		// a hard stop — AND that decision CHANGED something.
		// `rampDecisionChangedState` is the discriminator for the second half, and
		// the freeze's ladder position (`RampDecision.freeze.ladderMs`) is what it
		// reads: a breach on a cell already at the soft floor HOLDS the number while
		// imposing a fresh freeze and a fresh rung of the cooldown ladder, and that
		// is an incident; a hard stop that is merely still true an
		// hour later changed nothing and stays quiet rather than re-announcing
		// itself every tick. A ceiling pulling a healthy cell back to its rung has
		// no cause to name, and `awaiting_corroboration` is the branch that decided
		// NOT to act — neither carries a notice. `rampDecisionAdminNotice` is the
		// exact predicate and documents why it is exact. Persistent and
		// admin-visible, mirroring `mtaIpReadinessAlerts` — the shipped shape for a
		// delivery incident an operator must see.
		adminNotice: v.optional(v.string()),
		frozenUntil: v.optional(v.number()),
		// JSON snapshot of every gate's inputs and the hard-stop signals, so a
		// decision can be replayed against the pure function that made it. A blob
		// rather than a nested object: it is evidence, never a query predicate.
		snapshot: v.string(),
		expiresAt: v.number(),
	})
		// TENANT-SCOPED READS ONLY: `mixDecisions` is a tenant table, so the cell
		// index is keyed by organization first and there is no unscoped variant for
		// a caller to reach for.
		.index('by_org_cell_time', ['organizationId', 'cell', 'at'])
		.index('by_expires_at', ['expiresAt']),
};
