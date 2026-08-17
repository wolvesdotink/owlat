/**
 * The measurement screen's GATE copy: what each ramp gate is called, how each
 * verdict is toned and worded, and the sentence under a verdict that states the
 * numbers which produced it.
 *
 * Split from `deliverabilityMeasurement.ts` (which still owns the dashboard
 * types, the page framing and the arm comparison) to keep both files under the
 * size cap. It imports the dashboard types from there and nothing at runtime, so
 * the dependency runs one way; both live in `~/utils` and are auto-imported, so
 * neither re-exports the other's names.
 *
 * THE RULE THE WHOLE SCREEN OBEYS APPLIES HERE TOO: nothing in this module
 * divides. Every rate is DERIVED ON READ by the server's one summarizer (ADR-0042
 * / plan D5) and this module formats the number it was handed.
 *
 * STATES ARE THE FEATURE: `insufficient_data` is not a failure, and nothing that
 * is merely UNMEASURED is ever rendered in an error tone (plan D2).
 *
 * "THE CHECKS' WINDOW", NEVER "THIS WINDOW". Every number here is the
 * evaluator's, over the DECIDING span, under a card whose table covers the wider
 * reported one — so the sentence names whose window it means (#510).
 */

import { formatNumber, formatPercentage } from '~/utils/formatters';
import type { DeliverabilityDashboardGate, LocalizedText } from '~/utils/deliverabilityMeasurement';

const GATE_LABELS = {
	hard_bounce: 'shared.deliverabilityMeasurement.gate.hardBounce',
	deferral: 'shared.deliverabilityMeasurement.gate.deferral',
	complaint: 'shared.deliverabilityMeasurement.gate.complaint',
	engagement_ratio: 'shared.deliverabilityMeasurement.gate.engagement',
	seed_placement: 'shared.deliverabilityMeasurement.gate.seedPlacement',
} as const;

export function gateLabel(gate: DeliverabilityDashboardGate['gate']): LocalizedText {
	return GATE_LABELS[gate];
}

export type GateTone = 'ok' | 'attention' | 'stop' | 'neutral';

export type GateStatus = DeliverabilityDashboardGate['status'];

/**
 * How each verdict is presented — its TONE and its WORDS, decided together in
 * one table rather than in two switches over the same union.
 *
 * The pairing is the point: `insufficient_data` reads "Not enough data yet" and
 * is rendered NEUTRAL, because the measurement is thin and thin is not broken
 * (plan D10/D2). Splitting tone and label across two functions is how a status
 * ends up with alarming colour and calm words.
 */
export const GATE_STATUS_PRESENTATION = {
	pass: { tone: 'ok', label: 'shared.deliverabilityMeasurement.gateStatus.pass' },
	fail: { tone: 'attention', label: 'shared.deliverabilityMeasurement.gateStatus.fail' },
	halt: { tone: 'stop', label: 'shared.deliverabilityMeasurement.gateStatus.halt' },
	insufficient_data: {
		tone: 'neutral',
		label: 'shared.deliverabilityMeasurement.gateStatus.insufficientData',
	},
} as const satisfies Record<GateStatus, { tone: GateTone; label: string }>;

export function gateTone(status: GateStatus): GateTone {
	return GATE_STATUS_PRESENTATION[status].tone;
}

export function gateStatusLabel(status: GateStatus): LocalizedText {
	return GATE_STATUS_PRESENTATION[status].label;
}

/**
 * WHAT `ownSample` / `minSample` ARE COUNTING for a given gate.
 *
 * Almost every verdict is denominated in SENDS, and the server's `ownSample`
 * docblock (`gateTypes.ts`) names the two that are not: `seed_placement` counts
 * SEED PROBES, and the `block_message_detected` halt counts CLASSIFIED SMTP
 * RESPONSES. Under D17 the placement gate is a tripwire whose numbers an
 * operator reads directly, and under D12 the same fields render into the audit
 * row and the admin notification — so the unit is decided once, here, rather
 * than assumed to be "sends" by each sentence.
 *
 * A PROBE IS NOT A MAILBOX. `seedShadowCopy.ts` writes one probe per connected
 * seed mailbox per campaign send, and the roll-up's `sampleSize` sums those
 * probes over the whole window — so eight seed mailboxes across ten campaigns is
 * a sample of eighty, and "80 seed mailboxes" would overstate the coverage an
 * operator is being asked to trust by the send cadence. The mailbox count is a
 * different fact with its own copy (`add_seed_mailboxes`).
 */
function sampleUnit(gate: DeliverabilityDashboardGate['gate']): 'probes' | 'sends' {
	return gate === 'seed_placement' ? 'probes' : 'sends';
}

/**
 * The unit is a WORD INSIDE the sentence, so it picks the sentence rather than
 * filling a slot in one: "80 of 400 sends" and "80 of 400 seed probes" decline
 * differently once the sentence is not English, and a slot would have carried
 * another catalog key into the middle of this one.
 */
function unitKey(base: string, unit: 'probes' | 'sends'): string {
	return `${base}.${unit}`;
}

/**
 * THE SEED GATE'S DECIDED SENTENCE — status words and PROBE COUNTS, and no
 * share of anything (plan D17).
 *
 * SEEDS ARE A TRIPWIRE, NOT A GAUGE, and the two modules that produce the
 * reading enforce that on their own side: `seedPlacementGate.ts` keeps both
 * arms' shares inside itself and hands out a STATUS, and `placementAdapter.ts`
 * takes COUNTS, never a percentage, from a commercial panel. Rendering the same
 * verdict as "85.00% over 10 seed probes, against a limit of 90.00%" undoes
 * both: it invites an operator to read one probe as ten percentage points, to
 * chase the gap between two five-probe sweeps, and to treat a number with a
 * ±10pp resolution as a measurement of their inbox placement.
 *
 * The probe COUNT stays, because it is the honesty input — how thin the sweep
 * was is exactly what a reader needs to weigh the status beside it. It is
 * PROBES and it says so: the same seed mailbox is probed once per send, so the
 * count runs with the send cadence and reading it as "mailboxes" would inflate
 * the coverage by exactly that factor.
 *
 * A COMPARATIVE VERDICT IS A COMPARISON OF TWO SHARES, and the sentence has to
 * read as one. The two sweeps are sized independently, and the own arm
 * OUTGROWING the reference one is the ordinary late-ramp shape — 16 of 20 here
 * against 5 of 5 there breaches the tolerance while more probes reached the
 * inbox on this side, so "fewer of ours reached than of theirs" is not a
 * paraphrase of the verdict, it is a false statement about it. The counts are
 * quoted as SWEEP SIZES beside the comparison, never as its subject.
 *
 * "REACHED" IS THE SHARED MODULE'S WORD, and it means the inbox OR a tab:
 * `isSeedPlacementReached` counts `inbox` and `category`, and
 * `SeedPlacementStatus.inbox_dominant` is documented as "effectively everything
 * reached the inbox or a tab". A sentence that says "the inbox" alone calls a
 * Gmail Promotions probe a miss on the clean verdict and, symmetrically, has to
 * account for the `deleted` placement on the breach.
 */
const SEED_FALLBACK_KEYS = {
	pass: 'shared.deliverabilityMeasurement.seed.fallback.pass',
	fail: 'shared.deliverabilityMeasurement.seed.fallback.fail',
	halt: 'shared.deliverabilityMeasurement.seed.fallback.halt',
	insufficient_data: 'shared.deliverabilityMeasurement.seed.fallback.insufficientData',
} as const satisfies Record<GateStatus, string>;

function seedPlacementExplanation(gate: DeliverabilityDashboardGate): LocalizedText {
	const probes = formatNumber(gate.measurement.ownSample);
	switch (gate.reason) {
		case 'within_threshold':
			return {
				key: 'shared.deliverabilityMeasurement.seed.withinThreshold',
				params: { probes },
			};
		case 'reference_tolerance_breached':
			return {
				key: 'shared.deliverabilityMeasurement.seed.referenceToleranceBreached',
				params: {
					probes,
					referenceProbes: formatNumber(gate.measurement.referenceSample ?? 0),
				},
			};
		case 'absolute_threshold_breached':
			return {
				key: 'shared.deliverabilityMeasurement.seed.absoluteThresholdBreached',
				params: { probes },
			};
		default:
			// NOT exhaustive, and safe BECAUSE it carries no placement figure: the
			// seed gate decides exactly the three reasons above (`seedGate.ts` —
			// everything else it returns is a hold, which never reaches here), and a
			// reason added later gets the status word and the sweep size until it
			// earns its own sentence. That sentence can be thin; it cannot be wrong.
			//
			// So there is no `trailing_baseline_breached` arm. That reason is the
			// engagement and ceiling gates' word for a cell falling behind its OWN
			// past, and the standalone seed evaluator does not swap a baseline clause
			// in for the comparative one — it drops the second clause entirely. Copy
			// written ahead of a variant that does not exist is the speculative seam
			// `trailingBaselineGates.ts` cites plan D20 against.
			//
			// The status WORD is part of this sentence, so there is one sentence per
			// status rather than a status key slotted into a shared frame.
			return { key: SEED_FALLBACK_KEYS[gate.status], params: { probes } };
	}
}

/**
 * The sentence under a gate's verdict — the numbers that produced it, in words.
 *
 * A holding gate says how far off the floor it is ("124 of 400 sends in the
 * checks' window"), because "insufficient data" on its own reads as a fault in
 * the product rather than as a fact about the traffic.
 */
export function gateExplanation(gate: DeliverabilityDashboardGate): LocalizedText {
	const { measurement } = gate;
	const unit = sampleUnit(gate.gate);
	if (gate.status === 'insufficient_data') {
		// Bound to a LOCAL: switching on `gate.reason` narrows `gate` itself, so the
		// exhaustiveness check below would read a property off `never` instead of
		// proving the union was covered.
		const { reason } = gate;
		switch (reason) {
			case 'own_sample_below_floor':
				return {
					key: unitKey('shared.deliverabilityMeasurement.hold.ownSampleBelowFloor', unit),
					params: {
						sample: formatNumber(measurement.ownSample),
						floor: formatNumber(measurement.minSample),
					},
				};
			case 'reference_sample_below_floor':
				// The unit is the GATE's, not the sentence's: the seed gate's second sweep is
				// denominated in PROBES, and it reaches this reason whenever that sweep
				// is thin.
				return {
					key: unitKey('shared.deliverabilityMeasurement.hold.referenceSampleBelowFloor', unit),
					params: {
						sample: formatNumber(measurement.referenceSample ?? 0),
						floor: formatNumber(measurement.referenceMinSample ?? measurement.minSample),
					},
				};
			case 'baseline_sample_below_floor':
				return 'shared.deliverabilityMeasurement.hold.baselineSampleBelowFloor';
			case 'own_evidence_stale':
			case 'reference_evidence_stale':
			case 'baseline_evidence_stale':
				return 'shared.deliverabilityMeasurement.hold.evidenceStale';
			case 'own_rate_unmeasurable':
			case 'reference_rate_unmeasurable':
			case 'baseline_rate_unmeasurable':
				return 'shared.deliverabilityMeasurement.hold.rateUnmeasurable';
			case 'reference_not_a_denominator':
			case 'baseline_not_a_denominator':
				// NOT a fault, and the sentence must not read like one: the series this
				// check compares against is a perfectly good number that a relative
				// comparison cannot be built on — most often a clean window with nothing
				// in the numerator at all.
				return 'shared.deliverabilityMeasurement.hold.notADenominator';
			case 'own_deferral_telemetry_absent':
				// NOT "no deferrals" — that is the reading this hold exists to refuse.
				// The window is ample and clean; what is missing is anything recording
				// deferrals for this cell, and a zero from an instrument nobody switched
				// on must not be rendered as a healthy one.
				return 'shared.deliverabilityMeasurement.hold.deferralTelemetryAbsent';
			case 'evidence_absent':
				return 'shared.deliverabilityMeasurement.hold.evidenceAbsent';
			default: {
				// EXHAUSTIVE ON PURPOSE. A `default` that fell through to the "N of M
				// sends this window" sentence would put a confident, wrong number under
				// any hold reason a later gate adds — say a baseline reason, whose
				// sample is not this window's at all. A new `RampGateHoldReason` must
				// fail the typecheck here and be given its own sentence.
				const unhandled: never = reason;
				return unhandled;
			}
		}
	}
	// THE VERDICT THAT MAY NOT QUOTE A RATE AT ALL — decided BEFORE any rate is
	// formatted, so the D17 sentence cannot pick one up by accident.
	if (gate.gate === 'seed_placement') return seedPlacementExplanation(gate);
	const own = measurement.ownRate === null ? null : formatPercentage(measurement.ownRate, 2);
	const threshold = formatPercentage(measurement.thresholdRate, 2);
	const reference =
		measurement.referenceRate === null ? null : formatPercentage(measurement.referenceRate, 2);
	// THE VERDICT WHOSE SENTENCE IS NOT A RATE-AGAINST-A-LIMIT AT ALL. The
	// block-message hard stop counts CLASSIFIED SMTP RESPONSES (see `ownSample` in
	// the server's `gateTypes.ts`), and it reads as a share OF those responses
	// rather than as a rate over a sample — so it gets its own whole sentence.
	//
	// REACHABLE SINCE ISSUE #501 CLOSED: the MTA's classified responses now land in
	// a per-(cell, arm, day) counter, so a standalone cell whose window is at least
	// 0.5% refusals renders this sentence.
	if (gate.status === 'halt' && gate.reason === 'block_message_detected') {
		return {
			key: 'shared.deliverabilityMeasurement.verdict.blockMessages',
			params: {
				rate: own ?? '—',
				sample: formatNumber(measurement.ownSample),
				threshold,
			},
		};
	}
	// The comparison clause is a whole second sentence, so it picks the message
	// rather than being pasted onto the end of one.
	if (reference === null) {
		return {
			key: unitKey('shared.deliverabilityMeasurement.verdict.rate', unit),
			params: { rate: own ?? '—', sample: formatNumber(measurement.ownSample), threshold },
		};
	}
	return {
		key: unitKey('shared.deliverabilityMeasurement.verdict.rateWithComparison', unit),
		params: {
			rate: own ?? '—',
			sample: formatNumber(measurement.ownSample),
			threshold,
			referenceRate: reference,
			referenceSample: formatNumber(measurement.referenceSample ?? 0),
		},
	};
}
