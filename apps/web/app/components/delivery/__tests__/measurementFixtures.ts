/**
 * Fixtures for the deliverability measurement screen's component suite.
 *
 * Every fixture is typed against the SERVER'S OWN return type, so a change to
 * the query's shape breaks these tests rather than letting the screen drift
 * away from the data it renders. Nothing here computes a rate: the summaries
 * below carry the rates the server derived, which is exactly what the
 * components are required to print (plan D5).
 */

import type {
	DeliverabilityArmSummary,
	DeliverabilityDashboardCell,
	DeliverabilityDashboardGate,
} from '~/utils/deliverabilityMeasurement';

/** A zeroed arm summary — the shape of a cell nobody has sent through. */
export function armSummary(
	overrides: Partial<DeliverabilityArmSummary> = {}
): DeliverabilityArmSummary {
	return {
		sent: 0,
		delivered: 0,
		deferred: 0,
		softBounced: 0,
		hardBounced: 0,
		complained: 0,
		opened: 0,
		clicked: 0,
		unsubscribed: 0,
		calibrationSent: 0,
		calibrationOpened: 0,
		calibrationClicked: 0,
		bounced: 0,
		deliveryRate: 0,
		deferralRate: 0,
		bounceRate: 0,
		hardBounceRate: 0,
		complaintRate: 0,
		openRate: 0,
		clickRate: 0,
		unsubscribeRate: 0,
		calibrationOpenRate: 0,
		calibrationClickRate: 0,
		lastRecordedAt: null,
		...overrides,
	};
}

export function passingGate(
	gate: DeliverabilityDashboardGate['gate'] = 'hard_bounce'
): DeliverabilityDashboardGate {
	return {
		gate,
		status: 'pass',
		reason: 'within_threshold',
		measurement: {
			thresholdRate: 0.02,
			toleranceValuePp: 0.5,
			ownSample: 1000,
			referenceSample: 900,
			minSample: 200,
			ownRate: 0.004,
			referenceRate: 0.003,
		},
		confidence: 'high',
		mayJustifyIncrease: true,
	};
}

export function failingGate(
	gate: DeliverabilityDashboardGate['gate'] = 'hard_bounce'
): DeliverabilityDashboardGate {
	return {
		gate,
		status: 'fail',
		reason: 'absolute_threshold_breached',
		measurement: {
			thresholdRate: 0.02,
			toleranceValuePp: 0.5,
			ownSample: 1200,
			referenceSample: 1100,
			minSample: 200,
			ownRate: 0.041,
			referenceRate: 0.002,
		},
		confidence: 'high',
		mayJustifyIncrease: true,
	};
}

export function holdingGate(
	gate: DeliverabilityDashboardGate['gate'] = 'hard_bounce'
): DeliverabilityDashboardGate {
	return {
		gate,
		status: 'insufficient_data',
		reason: 'own_sample_below_floor',
		measurement: {
			thresholdRate: 0.02,
			toleranceValuePp: 0.5,
			ownSample: 124,
			referenceSample: null,
			minSample: 400,
			ownRate: null,
			referenceRate: null,
		},
		confidence: 'high',
		mayJustifyIncrease: true,
	};
}

export function cellView(
	overrides: Partial<DeliverabilityDashboardCell> = {}
): DeliverabilityDashboardCell {
	return {
		cell: { stream: 'campaign', destinationProvider: 'gmail' },
		cellKey: 'campaign:gmail',
		ownShare: 0.25,
		phaseCeiling: 0.5,
		cleanStreakIncludingThisWindow: 1,
		own: armSummary({ sent: 1000, delivered: 980, deliveryRate: 0.98 }),
		reference: armSummary({ sent: 900, delivered: 890, deliveryRate: 0.9889 }),
		verdict: 'pass',
		failedGate: null,
		requiresCorroboration: false,
		gates: [passingGate()],
		confidence: {
			level: 'high',
			improvements: [],
		},
		trend: [],
		...overrides,
	};
}

/**
 * THE SEED-PLACEMENT GATE — the other verdict whose sample is not denominated in
 * sends. `evaluateSeedGate` sets `ownSample` to the number of SEED MAILBOXES and
 * `minSample` to the floor in those same units, so both the decided sentence and
 * the below-floor hold have to say "seed mailboxes" rather than "sends". Under
 * D17 seeds are a tripwire an operator reads directly and under D12 the same
 * numbers render into the audit row, so the noun has to be right.
 *
 * The counts are deliberately tiny — 5-10 mailboxes per provider is the whole
 * sample, which is exactly why calling them sends would be so misleading.
 */
export function seedPlacementGate(): DeliverabilityDashboardGate {
	return {
		gate: 'seed_placement',
		status: 'fail',
		reason: 'absolute_threshold_breached',
		measurement: {
			thresholdRate: 0.9,
			toleranceValuePp: 5,
			ownSample: 10,
			referenceSample: null,
			minSample: 8,
			ownRate: 0.85,
			referenceRate: null,
		},
		confidence: 'medium',
		mayJustifyIncrease: true,
	};
}

/** The seed gate CLEAN — the sentence a healthy placement sweep renders. */
export function seedPlacementPass(): DeliverabilityDashboardGate {
	return {
		gate: 'seed_placement',
		status: 'pass',
		reason: 'within_threshold',
		measurement: {
			thresholdRate: 0.9,
			toleranceValuePp: 5,
			ownSample: 10,
			referenceSample: 10,
			minSample: 8,
			ownRate: 1,
			referenceRate: 1,
		},
		confidence: 'medium',
		mayJustifyIncrease: true,
	};
}

/**
 * The seed gate's COMPARATIVE breach: both sweeps are large enough, and the own
 * arm is behind the relay by more than the tolerance. The two sample sizes are
 * the only numbers this verdict may quote.
 */
export function seedPlacementReferenceBreach(): DeliverabilityDashboardGate {
	return {
		gate: 'seed_placement',
		status: 'fail',
		reason: 'reference_tolerance_breached',
		measurement: {
			thresholdRate: 0.9,
			toleranceValuePp: 5,
			ownSample: 10,
			referenceSample: 12,
			minSample: 8,
			ownRate: 0.9,
			referenceRate: 1,
		},
		confidence: 'medium',
		mayJustifyIncrease: true,
	};
}

/** The seed gate BELOW its mailbox floor — the hold sentence, in mailboxes. */
export function seedPlacementHold(): DeliverabilityDashboardGate {
	return {
		gate: 'seed_placement',
		status: 'insufficient_data',
		reason: 'own_sample_below_floor',
		measurement: {
			thresholdRate: 0.9,
			toleranceValuePp: 5,
			ownSample: 8,
			referenceSample: null,
			minSample: 20,
			ownRate: null,
			referenceRate: null,
		},
		confidence: 'medium',
		mayJustifyIncrease: true,
	};
}

/**
 * THE SEED GATE'S SECOND SWEEP, thin.
 *
 * `evaluateSeedGate` reaches `reference_sample_below_floor` when the COMPARISON
 * sweep is the thin one, and its `referenceSample` is seed mailboxes just as the
 * own sample is. The shape carries no `referenceMinSample`, so the sentence falls
 * back to `minSample` — which is the SEED floor, in seed mailboxes.
 */
export function seedPlacementReferenceHold(): DeliverabilityDashboardGate {
	return {
		gate: 'seed_placement',
		status: 'insufficient_data',
		reason: 'reference_sample_below_floor',
		measurement: {
			thresholdRate: 0.9,
			toleranceValuePp: 5,
			ownSample: 20,
			referenceSample: 3,
			minSample: 5,
			ownRate: 0.95,
			referenceRate: null,
		},
		confidence: 'medium',
		mayJustifyIncrease: true,
	};
}

/**
 * The BLOCK-MESSAGE HARD STOP — the one verdict whose sample is not denominated
 * in sends. `ownSample` counts CLASSIFIED SMTP RESPONSES and `minSample` is the
 * floor in those same units, which is why `gateExplanation` branches on the
 * reason rather than printing the generic "N sends" sentence.
 */
export function blockMessageHalt(): DeliverabilityDashboardGate {
	return {
		gate: 'deferral',
		status: 'halt',
		reason: 'block_message_detected',
		measurement: {
			thresholdRate: 0.005,
			toleranceValuePp: null,
			ownSample: 240,
			referenceSample: null,
			minSample: 20,
			ownRate: 0.05,
			referenceRate: null,
		},
		confidence: 'high',
		mayJustifyIncrease: true,
	};
}
