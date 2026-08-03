/**
 * Fixtures for the three ramp screens.
 *
 * Shaped like the SERVER's answers, not like whatever a component happens to
 * need: every field the queries return is present, so a screen that starts
 * reading a new one cannot quietly pass against a fixture that never had it.
 */
import type { IndependenceDayPoint } from '@owlat/shared/deliverabilityIndependence';
import type {
	RampAdminNotice,
	RampCellControl,
	RampCellDecision,
	RampControls,
} from '~/utils/deliverabilityRamp';
import type { IndependenceSummary } from '~/utils/deliverabilityIndependenceCopy';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const NOW = Date.UTC(2026, 6, 20);

export function decision(overrides: Partial<RampCellDecision> = {}): RampCellDecision {
	return {
		at: NOW - DAY_MS,
		fromShare: 0.2,
		toShare: 0.25,
		direction: 'increase',
		reason: 'healthy',
		message: 'Increased campaign mail to gmail (20% -> 25%): every gate is green.',
		failedGate: null,
		adminNotice: null,
		frozenUntil: null,
		...overrides,
	};
}

export function cellControl(overrides: Partial<RampCellControl> = {}): RampCellControl {
	return {
		cell: { stream: 'campaign', destinationProvider: 'gmail' },
		cellKey: 'campaign:gmail',
		isRampManaged: true,
		ownShare: 0.25,
		phaseCeiling: 0.5,
		cleanStreak: 2,
		graduatedAt: null,
		frozenUntil: null,
		isPaused: false,
		pinnedShare: null,
		lastDecision: decision(),
		...overrides,
	};
}

export function controlsView(overrides: Partial<RampControls> = {}): RampControls {
	return {
		generatedAt: NOW,
		referenceTransportId: 'ses',
		// TWO FACTS, NOT ONE. `referenceTransportId` names the single second arm;
		// this says whether there is a second sender AT ALL, and it is the one the
		// reset door cuts a share on — they come apart on a two-relay deployment.
		isRelayConfigured: true,
		isControllerPaused: false,
		presets: {},
		defaultPreset: 'balanced',
		cells: [cellControl()],
		...overrides,
	};
}

/** A rising series: own volume grows while the relay's shrinks. */
export function risingSeries(days = 14): IndependenceDayPoint[] {
	const points: IndependenceDayPoint[] = [];
	for (let index = 0; index < days; index += 1) {
		points.push({
			day: NOW - (days - index) * DAY_MS,
			own: 100 + index * 40,
			reference: Math.max(0, 900 - index * 40),
		});
	}
	return points;
}

export function independenceSummary(
	overrides: Partial<IndependenceSummary> = {}
): IndependenceSummary {
	return {
		generatedAt: NOW,
		referenceTransportId: 'ses',
		ownShare: 0.42,
		series: risingSeries(),
		projection: { kind: 'projected', at: NOW + 30 * DAY_MS, dailyGainPp: 1.4 },
		spendAvoidedMinorUnits: null,
		spendAvoidedCurrency: null,
		monthToDateOwnSends: 12_500,
		relayRemoval: {
			kind: 'unsafe',
			dependentCells: ['campaign:gmail'],
			projectedSafeAt: NOW + 30 * DAY_MS,
		},
		capacity: { remainingToday: 4_000, projectedDays: [4_000, 5_000] },
		...overrides,
	};
}

export function adminNotice(overrides: Partial<RampAdminNotice> = {}): RampAdminNotice {
	return {
		at: NOW - DAY_MS,
		cellKey: 'campaign:gmail',
		notice:
			'Reduced campaign mail to gmail (50% -> 25%): the hard bounce gate breached. Clean the list and re-verify the newest imports before it can climb again.',
		failedGate: 'hard_bounce',
		fromShare: 0.5,
		toShare: 0.25,
		...overrides,
	};
}
