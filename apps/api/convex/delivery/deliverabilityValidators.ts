import { v, type Infer } from 'convex/values';
import { SEED_PLACEMENTS } from '@owlat/shared/seedPlacement';
import type { RampPreset } from '@owlat/shared/deliverabilityIndependence';

/** Convex validators for the shared, fixed deliverability taxonomy. */
export const destinationProviderValidator = v.union(
	v.literal('gmail'),
	v.literal('microsoft'),
	v.literal('yahoo'),
	v.literal('apple'),
	v.literal('other')
);

/**
 * Where a seed probe was found. DERIVED from `SEED_PLACEMENTS` rather than
 * restated: the pure core owns the taxonomy, and a placement added there
 * becomes storable here without a second edit that could be forgotten.
 */
export const seedPlacementValidator = v.union(
	...SEED_PLACEMENTS.map((placement) => v.literal(placement))
);

export const deliverabilitySignalProviderValidator = v.union(
	v.literal('all'),
	destinationProviderValidator
);

export const deliverabilitySignalSourceValidator = v.union(
	v.literal('ip_quarantined'),
	v.literal('dnsbl_listed'),
	// Advisory measurement sources (see ADVISORY_DELIVERABILITY_SIGNAL_SOURCES):
	// recorded and readable, never a fallback trigger on their own.
	v.literal('dnsbl_partial'),
	v.literal('dnsbl_unknown'),
	v.literal('breaker_open'),
	v.literal('persistent_defers'),
	// Outcome-derived sources (see OUTCOME_DELIVERABILITY_SIGNAL_SOURCES): what
	// happened to mail that was ACCEPTED. They move the ramp controller's share;
	// they are never a shipped relay-fallback trigger on their own.
	v.literal('bounce_rate'),
	v.literal('complaint_rate'),
	v.literal('engagement_ratio'),
	v.literal('seed_placement')
);

/**
 * Sending stream — mirrors DELIVERABILITY_STREAM_KEYS in @owlat/shared, which
 * is itself an alias of the shipped GOVERNED_MESSAGE_TYPES. Parity with that
 * union is asserted in delivery/__tests__/routeStateMigration.test.ts.
 */
export const deliverabilityStreamValidator = v.union(
	v.literal('campaign'),
	v.literal('automation'),
	v.literal('transactional')
);

export const deliverabilitySignalSeverityValidator = v.union(
	v.literal('warning'),
	v.literal('critical')
);

export const deliverabilitySignalValidator = v.object({
	provider: deliverabilitySignalProviderValidator,
	source: deliverabilitySignalSourceValidator,
	severity: deliverabilitySignalSeverityValidator,
	observedAt: v.number(),
});

/**
 * Dual-transport alignment pre-flight (P3-5). Mirrors ALIGNMENT_CHECK_IDS /
 * ALIGNMENT_CHECK_STATUSES / AlignmentVerdict in
 * @owlat/shared/deliverabilityAlignment; parity is asserted in
 * delivery/__tests__/alignmentBlocking.test.ts.
 */
export const alignmentCheckIdValidator = v.union(
	v.literal('from_domain'),
	v.literal('spf'),
	v.literal('dkim'),
	v.literal('dmarc')
);

/** `unknown` is "DNS could not answer" — a hold, never a pass and never a fail. */
export const alignmentCheckStatusValidator = v.union(
	v.literal('pass'),
	v.literal('fail'),
	v.literal('unknown')
);

export const alignmentVerdictValidator = v.union(
	v.literal('aligned'),
	v.literal('single_arm'),
	v.literal('blocked'),
	v.literal('unknown')
);

export const alignmentCheckValidator = v.object({
	id: alignmentCheckIdValidator,
	status: alignmentCheckStatusValidator,
	detail: v.string(),
	remedy: v.string(),
});

/**
 * THE RAMP CONTROLLER'S GATES, as a stored vocabulary. Mirrors `RampGateId` in
 * delivery/ramp/gateTypes.ts; parity is asserted in
 * delivery/__tests__/mixDecisions.test.ts.
 */
export const rampGateIdValidator = v.union(
	v.literal('hard_bounce'),
	v.literal('deferral'),
	v.literal('complaint'),
	v.literal('engagement_ratio'),
	v.literal('seed_placement')
);

/**
 * WHY A CONTROLLER DECIDED WHAT IT DECIDED, as a stored vocabulary.
 *
 * Mirrors `RampDecisionReason` (= `RampControlReason | RampGateId`) in
 * delivery/ramp/controllerTypes.ts, which is what `controllerNarrative.ts`
 * switches on EXHAUSTIVELY to guarantee the 100%-human-readable-reason KPI. A
 * plain `v.string()` at the write boundary would leave that guarantee with no
 * counterpart in the stored data: a renamed or mistyped reason would land in
 * `mixDecisions` unremarked and nothing would ever read it back. Parity with
 * the TS union is asserted in delivery/__tests__/mixDecisions.test.ts.
 */
export const rampDecisionReasonValidator = v.union(
	v.literal('kill_switch'),
	v.literal('clock_unusable'),
	v.literal('abuse_status'),
	v.literal('breaker'),
	v.literal('dnsbl'),
	v.literal('frozen'),
	v.literal('share_unreadable'),
	v.literal('freeze_unreadable'),
	v.literal('holding'),
	v.literal('evidence_stale'),
	v.literal('awaiting_corroboration'),
	v.literal('capacity_unknown'),
	v.literal('window_open'),
	v.literal('building_confidence'),
	v.literal('capacity_ceiling'),
	v.literal('phase_ceiling'),
	v.literal('degradation_ceiling'),
	v.literal('healthy'),
	v.literal('graduated'),
	// THE OPERATOR'S OWN REASONS (plan D12). A human hand on the ramp is still a
	// decision, and a decision with no audit row is exactly the silence D12
	// forbids — so an operator hold, pin, force-advance or phase reset writes a
	// `mixDecisions` row with a reason of its own rather than borrowing a gate's.
	v.literal('operator_pause'),
	v.literal('operator_pin'),
	v.literal('operator_force_advance'),
	v.literal('operator_phase_reset'),
	v.literal('operator_enrollment'),
	v.literal('operator_phase_promotion'),
	rampGateIdValidator
);

/**
 * THE PACE ACTUATOR'S REASONS, as a stored vocabulary (plan D3, D12).
 *
 * The second actuator answers the SAME questions in the same order, so it
 * reports the share actuator's whole vocabulary and adds only the reasons that
 * are genuinely about a pace dial. Mirrors `PaceDecisionReason` in
 * delivery/ramp/paceTypes.ts; parity is asserted in
 * delivery/__tests__/mixDecisions.test.ts.
 */
export const paceDecisionReasonValidator = v.union(
	rampDecisionReasonValidator,
	v.literal('low_utilisation'),
	v.literal('day_already_advanced'),
	v.literal('share_moved_first'),
	v.literal('multiplier_unreadable'),
	v.literal('schedule_ceiling')
);

/**
 * The per-stream aggressiveness preset (plan D9, P3-6).
 *
 * The literals are re-listed rather than mapped from `RAMP_PRESET_KEYS`, because
 * a `v.union(...keys.map(v.literal))` erases to `Validator<string>` and would
 * cost every stored column and every argument its closed union. The assertion
 * below is what stops the two lists drifting: adding a key to
 * `RAMP_PRESET_KEYS` without adding it here is a compile error, and vice versa.
 */
export const rampPresetValidator = v.union(
	v.literal('conservative'),
	v.literal('balanced'),
	v.literal('aggressive')
);

type ValidatedRampPreset = Infer<typeof rampPresetValidator>;
/** Mutual assignability, expressed without either parameter constraining the other. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
type AssertTrue<T extends true> = T;
export type _RampPresetValidatorMatchesShared = AssertTrue<Exact<ValidatedRampPreset, RampPreset>>;
