import { defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
	deliverabilitySignalProviderValidator,
	deliverabilitySignalSeverityValidator,
	deliverabilitySignalSourceValidator,
	deliverabilityStreamValidator,
	destinationProviderValidator,
	paceDecisionReasonValidator,
	rampDecisionReasonValidator,
	rampGateIdValidator,
	rampPresetValidator,
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
		// standalone route). Stamped by the three writes that SET a rung —
		// enrolment, a promotion and a downward phase reset — and by nothing else:
		// the hourly AIMD loop moves the SHARE, never the rung, so a tick must not
		// be able to restart a dwell the cell has already served.
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
		// THE SECOND ACTUATOR'S STATE (plan D3, P3-7). Standalone there is no mix to
		// control — s === 1 by definition — so the controller writes a WARMING-PACE
		// MULTIPLIER against the per-(IP x mailboxProvider) daily cap instead. Same
		// gates, same AIMD, same freeze ladder; a different dial. Every field is
		// optional and absent on every row written before the pace actuator existed,
		// where an absent multiplier means the published schedule, unmodified.
		//
		// The freeze columns are the pace actuator's OWN and deliberately not the
		// share's: the two dials retreat independently, and one column shared
		// between them would let a share cooldown suppress a pace retreat (or the
		// reverse) for reasons neither actuator measured.
		paceMultiplier: v.optional(v.number()),
		paceCleanStreak: v.optional(v.number()),
		paceFrozenUntil: v.optional(v.number()),
		paceFreezeStartedAt: v.optional(v.number()),
		paceCooldownMs: v.optional(v.number()),
		paceFreezeReason: v.optional(
			v.union(v.literal('gate_breach'), v.literal('breaker'), v.literal('dnsbl'))
		),
		// THE PER-UTC-DAY IDEMPOTENCY ANCHOR (plan D19), as the `YYYY-MM-DD` key the
		// shipped MTA evaluator stores in `lastEvaluatedDate` — same shape, same
		// meaning. The controller ticks hourly and a warming schedule must advance
		// AT MOST ONCE per UTC day, so a tick that finds today's key here holds.
		paceLastEvaluatedUtcDay: v.optional(v.string()),
		// THE COMPOSITION INTERLOCK'S MEMORY (plan D3). The instant a pace increase
		// was WITHHELD because the share moved first in the same tick. The interlock
		// has to outlive the tick that fired it: the cron ticks hourly while the
		// share's evaluation window is a whole day, so an in-memory hand-off would
		// only postpone the pace step by an hour and both dials would still have
		// increased inside one window — the thing D3 forbids. The pace ladder holds
		// on this anchor until a whole `RAMP_AIMD.evaluationWindowMs` has passed.
		// RETREATS ARE NEVER GATED BY IT; only the increase rung reads it.
		paceDeferredAt: v.optional(v.number()),
		decidedAt: v.optional(v.number()),
		// THE OPERATOR'S HAND ON THE RAMP (P3-6), and both fields are deliberately
		// one-directional. `operatorPausedAt` suppresses INCREASES only and
		// `operatorPinnedShare` caps them; neither can block a retreat, because a
		// safety response an operator can switch off is not a safety response. The
		// controller's rungs are untouched — `applyRampCellControl` rewrites the
		// decision AFTER the pure function has made it, so the audit row records
		// what the operator's setting actually produced.
		operatorPausedAt: v.optional(v.number()),
		operatorPinnedShare: v.optional(v.number()),
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
		// THE NOTICE'S OWN CLOCK, and the only reason it exists as a second column
		// is that Convex indexes cannot be partial. Written ONLY on a row that
		// carries an `adminNotice`, and always equal to `at` on those rows, so the
		// `by_org_notice` index below contains exactly the retreats and nothing
		// else. Without it the feed can only take a fixed page of `by_org_time` —
		// which the controller fills with roughly a hundred no-op rows a day, so a
		// retreat older than a day or two could never appear in a screen whose
		// whole promise (D12) is that every decrease surfaces here.
		noticeAt: v.optional(v.number()),
		frozenUntil: v.optional(v.number()),
		// THE SECOND ACTUATOR'S HALF OF THE SAME EVALUATION (plan D3, D12). One
		// controller decides both dials in one tick, so one row records both —
		// splitting them across two rows would make "what did the controller do to
		// this cell at 14:00" a join. Absent on a row written for a deployment with
		// no pace state, which is every row written before the pace dial existed.
		//
		// `isPaceDeferred` is the COMPOSITION INTERLOCK, recorded rather than
		// inferred: share moves first and pace moves second, and a cell may never
		// increase both in one window. When the interlock fires, `paceReason` reads
		// `share_moved_first` and the multiplier holds — which is a decision an
		// operator is entitled to see spelled out, not one they should have to
		// reconstruct by comparing two numbers.
		fromPaceMultiplier: v.optional(v.number()),
		toPaceMultiplier: v.optional(v.number()),
		paceDirection: v.optional(
			v.union(v.literal('increase'), v.literal('decrease'), v.literal('hold'))
		),
		paceReason: v.optional(paceDecisionReasonValidator),
		isPaceDeferred: v.optional(v.boolean()),
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
		// THE LAST DECISION PER CELL, in ONE bounded page. The Cells and Controls
		// screens want fifteen cells' most recent rows; scanning `by_org_cell_time`
		// once per cell reads fifteen pages to build one grid.
		.index('by_org_time', ['organizationId', 'at'])
		// THE ADMIN NOTIFICATION FEED (plan D12). `noticeAt` is set only on rows
		// carrying an `adminNotice`, so this index holds exactly the retreats and a
		// range read over it never pages past a no-op.
		.index('by_org_notice', ['organizationId', 'noticeAt'])
		.index('by_expires_at', ['expiresAt']),

	// The per-stream aggressiveness preset (plan D9, P3-6).
	//
	// A ROW ONLY WHERE A HUMAN CHOSE ONE. Absence is the default — `balanced`
	// with a relay, `conservative` standalone (plan D14) — so a deployment that
	// never opens the Controls screen has no rows here and runs exactly the
	// shipped constants. The preset is a SUBSTITUTION over `RAMP_STREAM_CONFIGS`
	// (`applyRampPreset` in @owlat/shared), never a second constant table, and it
	// can only make the ADVANCE cheaper or dearer: there is no field here that
	// could touch the multiplicative decrease, the floor, the cooldown ladder or
	// any hard stop.
	rampStreamPresets: defineTable({
		organizationId: v.string(),
		stream: deliverabilityStreamValidator,
		preset: rampPresetValidator,
		updatedAt: v.number(),
		updatedByUserId: v.string(),
	}).index('by_org_stream', ['organizationId', 'stream']),
};
