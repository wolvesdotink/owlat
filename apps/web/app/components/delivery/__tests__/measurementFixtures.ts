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
