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
 */

import type { FunctionReturnType } from 'convex/server';
import type { api } from '@owlat/api';
import { formatNumber, formatPercentage } from '~/utils/formatters';

export type DeliverabilityDashboard = FunctionReturnType<
	typeof api.delivery.deliverabilityDashboard.getDeliverabilityDashboard
>;
export type DeliverabilityDashboardCell = DeliverabilityDashboard['cells'][number];
export type DeliverabilityDashboardGate = DeliverabilityDashboardCell['gates'][number];
export type DeliverabilityArmSummary = DeliverabilityDashboardCell['own'];
export type DeliverabilityConfidence = DeliverabilityDashboardCell['confidence'];

/**
 * The headline, D14 literally: without a reference transport the feature is
 * "Warm-up autopilot" (how much can I send today, and what is holding it back),
 * not a degraded "Sending independence".
 */
export function measurementHeadline(referenceTransportId: string | null): string {
	return referenceTransportId === null ? 'Warm-up autopilot' : 'Sending independence';
}

export function measurementSubhead(referenceTransportId: string | null): string {
	return referenceTransportId === null
		? 'What your own server is sending, and how much of it is measurable. Read-only — nothing here changes your sending.'
		: `How your own server compares with ${referenceTransportId} on the same traffic. Read-only — nothing here changes your sending.`;
}

const STREAM_LABELS = {
	campaign: 'Campaign',
	automation: 'Automation',
	transactional: 'Transactional',
} as const;

const PROVIDER_LABELS = {
	gmail: 'Gmail',
	microsoft: 'Microsoft',
	yahoo: 'Yahoo',
	apple: 'Apple',
	other: 'Everywhere else',
} as const;

export function streamLabel(stream: DeliverabilityDashboardCell['cell']['stream']): string {
	return STREAM_LABELS[stream];
}

export function providerLabel(
	provider: DeliverabilityDashboardCell['cell']['destinationProvider']
): string {
	return PROVIDER_LABELS[provider];
}

export function cellLabel(cell: DeliverabilityDashboardCell['cell']): string {
	return `${streamLabel(cell.stream)} → ${providerLabel(cell.destinationProvider)}`;
}

// ============ GATES ============

const GATE_LABELS = {
	hard_bounce: 'Hard bounces',
	deferral: 'Deferrals',
	complaint: 'Complaints',
	engagement_ratio: 'Engagement',
	seed_placement: 'Seed placement',
} as const;

export function gateLabel(gate: DeliverabilityDashboardGate['gate']): string {
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
	pass: { tone: 'ok', label: 'Healthy' },
	fail: { tone: 'attention', label: 'Needs attention' },
	halt: { tone: 'stop', label: 'Stopped' },
	insufficient_data: { tone: 'neutral', label: 'Not enough data yet' },
} as const satisfies Record<GateStatus, { tone: GateTone; label: string }>;

export function gateTone(status: GateStatus): GateTone {
	return GATE_STATUS_PRESENTATION[status].tone;
}

export function gateStatusLabel(status: GateStatus): string {
	return GATE_STATUS_PRESENTATION[status].label;
}

/**
 * The sentence under a gate's verdict — the numbers that produced it, in words.
 *
 * A holding gate says how far off the floor it is ("124 of 400 sends this
 * window"), because "insufficient data" on its own reads as a fault in the
 * product rather than as a fact about the traffic.
 */
/**
 * WHAT `ownSample` / `minSample` ARE COUNTING for a given gate.
 *
 * Almost every verdict is denominated in SENDS, and the server's `ownSample`
 * docblock (`gateTypes.ts`) names the two that are not: `seed_placement` counts
 * SEED MAILBOXES, and the `block_message_detected` halt counts CLASSIFIED SMTP
 * RESPONSES. Under D17 the placement gate is a tripwire whose numbers an
 * operator reads directly, and under D12 the same fields render into the audit
 * row and the admin notification — so the unit is decided once, here, rather
 * than assumed to be "sends" by each sentence.
 */
function sampleUnit(gate: DeliverabilityDashboardGate['gate']): string {
	return gate === 'seed_placement' ? 'seed mailboxes' : 'sends';
}

/**
 * THE SEED GATE'S DECIDED SENTENCE — status words and MAILBOX COUNTS, and no
 * share of anything (plan D17).
 *
 * SEEDS ARE A TRIPWIRE, NOT A GAUGE, and the two modules that produce the
 * reading enforce that on their own side: `seedPlacementGate.ts` keeps both
 * arms' shares inside itself and hands out a STATUS, and `placementAdapter.ts`
 * takes COUNTS, never a percentage, from a commercial panel. Rendering the same
 * verdict as "85.00% over 10 seed mailboxes, against a limit of 90.00%" undoes
 * both: it invites an operator to read one mailbox as ten percentage points, to
 * chase the gap between two five-probe sweeps, and to treat a number with a
 * ±10pp resolution as a measurement of their inbox placement.
 *
 * The mailbox COUNT stays, because it is the honesty input — how thin the sweep
 * was is exactly what a reader needs to weigh the status beside it.
 *
 * A COMPARATIVE VERDICT IS A COMPARISON OF TWO SHARES, and the sentence has to
 * read as one. The two sweeps are sized independently, and the own arm
 * OUTGROWING the reference one is the ordinary late-ramp shape — 16 of 20 here
 * against 5 of 5 there breaches the tolerance while more mailboxes reached the
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
function seedPlacementExplanation(gate: DeliverabilityDashboardGate): string {
	const mailboxes = formatNumber(gate.measurement.ownSample);
	switch (gate.reason) {
		case 'within_threshold':
			return `Effectively all of the ${mailboxes} seed mailboxes reached the inbox or a tab.`;
		case 'reference_tolerance_breached':
			return `This cell's seed mailboxes reached the inbox or a tab less often than the comparison transport's did — ${mailboxes} swept here, ${formatNumber(gate.measurement.referenceSample ?? 0)} there.`;
		case 'absolute_threshold_breached':
			return `Some of the ${mailboxes} seed mailboxes did not reach the inbox or a tab — they were filtered to spam, deleted, or not found in any folder.`;
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
			return `${gateStatusLabel(gate.status)} — this check swept ${mailboxes} seed mailboxes.`;
	}
}

export function gateExplanation(gate: DeliverabilityDashboardGate): string {
	const { measurement } = gate;
	const unit = sampleUnit(gate.gate);
	if (gate.status === 'insufficient_data') {
		// Bound to a LOCAL: switching on `gate.reason` narrows `gate` itself, so the
		// exhaustiveness check below would read a property off `never` instead of
		// proving the union was covered.
		const { reason } = gate;
		switch (reason) {
			case 'own_sample_below_floor':
				return `Not enough data yet — ${formatNumber(measurement.ownSample)} of ${formatNumber(measurement.minSample)} ${unit} this window.`;
			case 'reference_sample_below_floor':
				// The unit is the GATE's, not the sentence's: the seed gate's second sweep is
				// denominated in MAILBOXES, and it reaches this reason whenever that sweep
				// is thin.
				return `Not enough data yet — ${formatNumber(measurement.referenceSample ?? 0)} of ${formatNumber(measurement.referenceMinSample ?? measurement.minSample)} ${unit} on the comparison transport this window.`;
			case 'baseline_sample_below_floor':
				return `Not enough history yet — this cell has not sent enough over the past 30 days to be compared with its own past.`;
			case 'own_evidence_stale':
			case 'reference_evidence_stale':
			case 'baseline_evidence_stale':
				return 'No recent sending in this cell, so there is nothing fresh to measure.';
			case 'own_rate_unmeasurable':
			case 'reference_rate_unmeasurable':
			case 'baseline_rate_unmeasurable':
				return 'The recorded counters for this window could not be read as a rate, so this check is holding.';
			case 'reference_not_a_denominator':
			case 'baseline_not_a_denominator':
				// NOT a fault, and the sentence must not read like one: the series this
				// check compares against is a perfectly good number that a relative
				// comparison cannot be built on — most often a clean window with nothing
				// in the numerator at all.
				return 'The window this check compares against is too clean to compare with — there is no relative verdict to give yet.';
			case 'evidence_absent':
				return 'Nothing has been measured for this cell yet.';
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
	if (gate.status === 'halt' && gate.reason === 'block_message_detected') {
		return `${own ?? '—'} of the ${formatNumber(measurement.ownSample)} classified SMTP responses this window were block messages, against a limit of ${threshold}.`;
	}
	const comparison =
		reference === null
			? ''
			: ` Comparison transport: ${reference} over ${formatNumber(measurement.referenceSample ?? 0)} ${unit}.`;
	return `${own ?? '—'} over ${formatNumber(measurement.ownSample)} ${unit}, against a limit of ${threshold}.${comparison}`;
}

// ============ CONFIDENCE (D14) ============

export function confidenceLabel(level: DeliverabilityConfidence['level']): string {
	switch (level) {
		case 'none':
			return 'Nothing sent yet';
		case 'low':
			return 'Measurement confidence: low';
		case 'medium':
			return 'Measurement confidence: medium';
		case 'high':
			return 'Measurement confidence: high';
	}
}

/**
 * What would make this cell's measurement better, as an INVITATION. Never a
 * warning, never a nag: the absence of a relay or of seed mailboxes is a
 * supported configuration (plan D2).
 */
export function improvementCopy(
	improvement: DeliverabilityConfidence['improvements'][number]
): string {
	switch (improvement) {
		case 'connect_reference_transport':
			return 'Connect a relay you already pay for to compare the same traffic side by side.';
		case 'add_seed_mailboxes':
			return 'Add seed mailboxes to spot a placement collapse the other signals cannot see.';
		case 'send_more_volume':
			return 'Send more in this cell — the checks need a larger sample before they can decide.';
	}
}

// ============ ARM COMPARISON ============

export interface ArmMetricRow {
	readonly key: string;
	readonly label: string;
	/** Absolute count, formatted. */
	readonly ownCount: string;
	readonly referenceCount: string | null;
	/** Server-derived rate, formatted — never computed here. */
	readonly ownRate: string | null;
	readonly referenceRate: string | null;
}

interface MetricSpec {
	readonly key: string;
	readonly label: string;
	readonly count: (summary: DeliverabilityArmSummary) => number;
	readonly rate?: (summary: DeliverabilityArmSummary) => number;
}

/**
 * The comparison table's rows. Each one names the COUNTER it prints and, where
 * the server derived one, the RATE field it prints — both read straight off the
 * summary. There is no arithmetic in this table.
 */
const METRIC_SPECS: readonly MetricSpec[] = [
	{ key: 'sent', label: 'Sent', count: (s) => s.sent },
	{ key: 'delivered', label: 'Delivered', count: (s) => s.delivered, rate: (s) => s.deliveryRate },
	{
		key: 'hardBounced',
		label: 'Hard bounces',
		count: (s) => s.hardBounced,
		rate: (s) => s.hardBounceRate,
	},
	{ key: 'softBounced', label: 'Soft bounces', count: (s) => s.softBounced },
	{
		key: 'complained',
		label: 'Complaints',
		count: (s) => s.complained,
		rate: (s) => s.complaintRate,
	},
	{ key: 'opened', label: 'Opens', count: (s) => s.opened, rate: (s) => s.openRate },
	{ key: 'clicked', label: 'Clicks', count: (s) => s.clicked, rate: (s) => s.clickRate },
	{
		key: 'unsubscribed',
		label: 'Unsubscribes',
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
