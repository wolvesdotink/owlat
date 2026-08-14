/**
 * Deliverability measurement screen — presentation only (plan D2, D5, D14).
 *
 * THE RULE: nothing in this module divides. Every rate on this screen is
 * DERIVED ON READ by the server's one summarizer (ADR-0042 / plan D5), and the
 * screen's job is to format the number it was handed and to put the right
 * sentence next to it. A percentage here is a unit conversion of a server rate,
 * never a rate computed from two counters — that is precisely how a dashboard
 * and a controller end up disagreeing about the same traffic.
 *
 * STATES ARE THE FEATURE. `insufficient_data` is not a failure, an absent
 * reference transport is not an incomplete setup, and a quiet cell is not a
 * problem. The copy below says so in words, and the tones below say so in
 * colour: nothing that is merely UNMEASURED is ever rendered in an error tone
 * (plan D2).
 *
 * TWO SPANS, AND EVERY SENTENCE SAYS WHICH ONE IT IS OVER. The server counts
 * over a WINDOW of seven days and reaches every gate verdict over the ramp
 * controller's own, shorter DECIDING span, so the two readers agree on the
 * verdict (#510). A gate sentence here reading "this window" beside a table
 * covering a different one would be the same lie the server just stopped
 * telling, so the sentences say whose window they mean and
 * `deliverabilityWindows.ts` puts each span into words for the headings.
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import { formatNumber, formatPercentage } from '~/utils/formatters';
import { transportIdLabel } from '~/utils/transportState';

export type DeliverabilityDashboard = FunctionReturnType<
	typeof api.delivery.deliverabilityDashboard.getDeliverabilityDashboard
>;
export type DeliverabilityDashboardCell = DeliverabilityDashboard['cells'][number];
export type DeliverabilityDashboardGate = DeliverabilityDashboardCell['gates'][number];
export type DeliverabilityArmSummary = DeliverabilityDashboardCell['own'];
export type DeliverabilityConfidence = DeliverabilityDashboardCell['confidence'];

/**
 * A sentence this module hands out: the catalog KEY that carries it, plus the
 * numbers it interpolates. Every table here is module scope and evaluated at
 * import time, so none of them can call `useI18n` — the screen that renders a
 * value is the boundary that turns it into words (the registry convention). A
 * plain string is a key with no parameters.
 */
export type LocalizedText = string | { key: string; params?: Record<string, unknown> };

/**
 * The headline, D14 literally: with nothing to compare against, the feature is
 * "Warm-up autopilot" (how much can I send today, and what is holding it back),
 * not a degraded "Sending independence".
 *
 * IT TAKES THE MEASUREMENT, NOT THE CONFIGURATION. Whether a comparison EXISTS
 * is what the cells below say — a two-relay deployment has no single relay to
 * name and every cell still measured against one — so a headline keyed to the
 * relay list tells such a deployment the opposite of what its own cards say.
 * Naming the relay is a separate question, answered by `referenceTransportId`.
 */
export function measurementHeadline(hasReferenceArm: boolean): LocalizedText {
	return hasReferenceArm
		? 'shared.deliverabilityMeasurement.headline.independence'
		: 'shared.deliverabilityMeasurement.headline.warmup';
}

/**
 * THE SECOND ARM IS NAMED THE WAY THE OPERATOR CHOSE IT. The reference
 * transport reaches this screen as its stored id (`ses`, `smtp`,
 * `plugin.<pack>.<id>`), which is a configuration value rather than a name —
 * `transportIdLabel` turns it back into words, with the scope and the one
 * remaining plugin-catalog gap stated there.
 *
 * THE TWO INPUTS ARE INDEPENDENT, and all four combinations are real. A
 * measured arm with no id to name is a deployment relaying through more than one
 * kind; an id with no measured arm is a relay that carried nothing this window,
 * and that reads as standalone because that is what the gates below graded it
 * as.
 */
export function measurementSubhead(input: {
	readonly hasReferenceArm: boolean;
	readonly referenceTransportId: string | null;
}): LocalizedText {
	if (!input.hasReferenceArm) return 'shared.deliverabilityMeasurement.subhead.standalone';
	// TWO SENTENCES, NOT ONE WITH A SUBJECT SLOT: the unnamed arm's phrase is copy
	// of its own, and a translator has to be able to word it inside the sentence.
	if (input.referenceTransportId === null) {
		return 'shared.deliverabilityMeasurement.subhead.relays';
	}
	return {
		key: 'shared.deliverabilityMeasurement.subhead.namedRelay',
		params: { relay: transportIdLabel(input.referenceTransportId) },
	};
}

/**
 * THE STANDALONE NOTE — shown only where no cell below measured a second arm.
 *
 * TWO KEYS IN ONE PARAGRAPH, and the split is the point. The FRAMING is a
 * measurement: whatever the deployment owns, everything below was graded against
 * our own history, so it follows the cells like the headline does. The
 * connect-a-relay OFFER is a configuration: it is advice about the deployment,
 * and nobody with a relay connected can act on it.
 *
 * Keyed together, a deployment whose relay had merely gone quiet was offered a
 * relay it already pays for three lines above the card's own line explaining
 * that its relay carried the cell earlier in this window — one screen saying the
 * relay does not exist and that it went quiet. `dashboardConfidence` splits the
 * per-cell cap from the per-cell offer on exactly this line; this is the same
 * split for the page prose that makes the same offer.
 *
 * A THIRD FACT, because the closing sentence is a PROMISE ABOUT THE CARDS: "the
 * days it did carry are still plotted" only holds where some card's trend
 * actually carries a relay day. The arm is graded over the controller's ~24h
 * span and the trend plots seven days, so those two diverge often — but they
 * also agree at zero: a graduated deployment at full own share, a relay
 * connected today, a relay enabled for a messageType outside these streams. In
 * all three this note renders with nothing plotted anywhere, and the sentence
 * would point at bars that do not exist. `hasPlottedRelayHistory` is the same
 * predicate the card guards its own line with (`point.reference !== null`),
 * asked across every cell rather than one.
 */
export function standaloneNote(input: {
	readonly isRelayConfigured: boolean;
	readonly referenceTransportId: string | null;
	readonly hasPlottedRelayHistory: boolean;
}): LocalizedText {
	if (!input.isRelayConfigured) return 'shared.deliverabilityMeasurement.standaloneNote.noRelay';
	// A configured relay with no measured arm. `null` here is the OTHER null:
	// more than one relay kind, so there is no single one to name — and the
	// subject, its pronoun and the closing promise are all one sentence per
	// combination, because a subject and a pronoun slotted into a shared frame is
	// a sentence no translator can put into another grammar.
	if (input.referenceTransportId === null) {
		return input.hasPlottedRelayHistory
			? 'shared.deliverabilityMeasurement.standaloneNote.relaysPlotted'
			: 'shared.deliverabilityMeasurement.standaloneNote.relays';
	}
	return {
		key: input.hasPlottedRelayHistory
			? 'shared.deliverabilityMeasurement.standaloneNote.namedRelayPlotted'
			: 'shared.deliverabilityMeasurement.standaloneNote.namedRelay',
		params: { relay: transportIdLabel(input.referenceTransportId) },
	};
}

const STREAM_LABELS = {
	campaign: 'shared.deliverabilityMeasurement.stream.campaign',
	automation: 'shared.deliverabilityMeasurement.stream.automation',
	transactional: 'shared.deliverabilityMeasurement.stream.transactional',
} as const;

const PROVIDER_LABELS = {
	gmail: 'shared.deliverabilityMeasurement.provider.gmail',
	microsoft: 'shared.deliverabilityMeasurement.provider.microsoft',
	yahoo: 'shared.deliverabilityMeasurement.provider.yahoo',
	apple: 'shared.deliverabilityMeasurement.provider.apple',
	other: 'shared.deliverabilityMeasurement.provider.other',
} as const;

export function streamLabel(stream: DeliverabilityDashboardCell['cell']['stream']): LocalizedText {
	return STREAM_LABELS[stream];
}

export function providerLabel(
	provider: DeliverabilityDashboardCell['cell']['destinationProvider']
): LocalizedText {
	return PROVIDER_LABELS[provider];
}

/**
 * THE CELL'S NAME AS ONE MESSAGE, not two names either side of an arrow.
 *
 * A cell's name is a catalog entry per (stream, provider) pair rather than a
 * frame with two slots, because a slot could only be filled with the OTHER
 * entries' keys — and a key interpolated into a sentence renders as itself. The
 * pair is closed and exhaustive on both axes, so every combination has a name.
 */
export function cellLabel(cell: DeliverabilityDashboardCell['cell']): LocalizedText {
	return `shared.deliverabilityMeasurement.cell.${cell.stream}.${cell.destinationProvider}`;
}

// ============ GATES ============

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
 * The sentence under a gate's verdict — the numbers that produced it, in words.
 *
 * A holding gate says how far off the floor it is ("124 of 400 sends in the
 * checks' window"), because "insufficient data" on its own reads as a fault in
 * the product rather than as a fact about the traffic.
 *
 * "THE CHECKS' WINDOW", NEVER "THIS WINDOW". Every number here is the
 * evaluator's, over the DECIDING span, under a card whose table covers the wider
 * reported one — so the sentence names whose window it means (#510).
 */
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

// ============ CONFIDENCE (D14) ============

export function confidenceLabel(level: DeliverabilityConfidence['level']): LocalizedText {
	switch (level) {
		case 'none':
			return 'shared.deliverabilityMeasurement.confidence.none';
		case 'low':
			return 'shared.deliverabilityMeasurement.confidence.low';
		case 'medium':
			return 'shared.deliverabilityMeasurement.confidence.medium';
		case 'high':
			return 'shared.deliverabilityMeasurement.confidence.high';
	}
}

/**
 * What would make this cell's measurement better, as an INVITATION. Never a
 * warning, never a nag: the absence of a relay or of seed mailboxes is a
 * supported configuration (plan D2).
 */
export function improvementCopy(
	improvement: DeliverabilityConfidence['improvements'][number]
): LocalizedText {
	switch (improvement) {
		case 'connect_reference_transport':
			return 'shared.deliverabilityMeasurement.improvement.connectReferenceTransport';
		case 'add_seed_mailboxes':
			return 'shared.deliverabilityMeasurement.improvement.addSeedMailboxes';
		case 'send_more_volume':
			return 'shared.deliverabilityMeasurement.improvement.sendMoreVolume';
	}
}

// ============ ARM COMPARISON ============

export interface ArmMetricRow {
	readonly key: string;
	readonly label: LocalizedText;
	/** Absolute count, formatted. */
	readonly ownCount: string;
	readonly referenceCount: string | null;
	/** Server-derived rate, formatted — never computed here. */
	readonly ownRate: string | null;
	readonly referenceRate: string | null;
}

interface MetricSpec {
	readonly key: string;
	readonly label: LocalizedText;
	readonly count: (summary: DeliverabilityArmSummary) => number;
	readonly rate?: (summary: DeliverabilityArmSummary) => number;
}

/**
 * The comparison table's rows. Each one names the COUNTER it prints and, where
 * the server derived one, the RATE field it prints — both read straight off the
 * summary. There is no arithmetic in this table.
 */
const METRIC_SPECS: readonly MetricSpec[] = [
	{ key: 'sent', label: 'shared.deliverabilityMeasurement.metric.sent', count: (s) => s.sent },
	{
		key: 'delivered',
		label: 'shared.deliverabilityMeasurement.metric.delivered',
		count: (s) => s.delivered,
		rate: (s) => s.deliveryRate,
	},
	{
		key: 'hardBounced',
		label: 'shared.deliverabilityMeasurement.metric.hardBounced',
		count: (s) => s.hardBounced,
		rate: (s) => s.hardBounceRate,
	},
	{
		key: 'softBounced',
		label: 'shared.deliverabilityMeasurement.metric.softBounced',
		count: (s) => s.softBounced,
	},
	{
		key: 'complained',
		label: 'shared.deliverabilityMeasurement.metric.complained',
		count: (s) => s.complained,
		rate: (s) => s.complaintRate,
	},
	{
		key: 'opened',
		label: 'shared.deliverabilityMeasurement.metric.opened',
		count: (s) => s.opened,
		rate: (s) => s.openRate,
	},
	{
		key: 'clicked',
		label: 'shared.deliverabilityMeasurement.metric.clicked',
		count: (s) => s.clicked,
		rate: (s) => s.clickRate,
	},
	{
		key: 'unsubscribed',
		label: 'shared.deliverabilityMeasurement.metric.unsubscribed',
		count: (s) => s.unsubscribed,
		rate: (s) => s.unsubscribeRate,
	},
];

export function armMetricRows(
	own: DeliverabilityArmSummary,
	reference: DeliverabilityArmSummary | null
): ArmMetricRow[] {
	return METRIC_SPECS.map((spec) => ({
		key: spec.key,
		label: spec.label,
		ownCount: formatNumber(spec.count(own)),
		referenceCount: reference === null ? null : formatNumber(spec.count(reference)),
		ownRate: spec.rate === undefined ? null : formatPercentage(spec.rate(own), 2),
		referenceRate:
			spec.rate === undefined || reference === null
				? null
				: formatPercentage(spec.rate(reference), 2),
	}));
}

/** A cell nobody has sent through this window — empty, and calm about it. */
export function isZeroVolume(cell: DeliverabilityDashboardCell): boolean {
	return cell.own.sent === 0 && (cell.reference === null || cell.reference.sent === 0);
}

/** Share of the cell the own server carries, as a display string (D1). */
export function ownShareLabel(cell: DeliverabilityDashboardCell): string {
	return formatPercentage(cell.ownShare, 0);
}
