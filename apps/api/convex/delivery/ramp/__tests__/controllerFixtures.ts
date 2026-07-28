/**
 * Fixtures for the AIMD ramp controller's decision-function suites.
 *
 * Gate results are built through the REAL aggregator (`aggregateRampGates`), so
 * a fixture cannot assert a verdict the gate layer could never produce — the
 * controller's tests stay pinned to the gate layer's actual behaviour rather
 * than to a hand-written mock of it.
 */

import type { DeliverabilityCell } from '@owlat/shared/deliverabilityRouting';
import { aggregateRampGates } from '../gateEvaluation';
import { RAMP_STREAM_CONFIGS } from '../gateConfig';
import { externalDataAllowed, rampGateMatrixMode } from './gateMatrixMode';
import type {
	RampGateDecidedMeasurement,
	RampGateEvaluation,
	RampGateHoldMeasurement,
	RampGateId,
	RampGateResult,
} from '../gateTypes';
import type {
	RampCapacityInput,
	RampControllerInput,
	RampHardStopSignals,
	RampMixState,
} from '../controllerTypes';

export const NOW = 1_800_000_000_000;
export const HOUR = 60 * 60 * 1000;
export const DAY = 24 * HOUR;

export const GMAIL_CAMPAIGN: DeliverabilityCell = {
	stream: 'campaign',
	destinationProvider: 'gmail',
};

/**
 * THE STANDALONE LEG IS A DIFFERENT WORLD, NOT THE SAME ONE WITH EXTRA ASSERTIONS.
 *
 * `ramp-gate-matrix` runs everything under `ramp/` twice, and these fixtures feed
 * all six controller suites. If they carried a reference arm unconditionally, the
 * standalone leg would execute those suites byte-identically to the equipped leg —
 * two green checks, one configuration actually tested, which is exactly the
 * failure `gateMatrixMode.ts` exists to prevent. So the measurement literals are
 * DERIVED from the leg: standalone builds every measurement with no second arm at
 * all. The controller reads only the aggregate verdict, so this costs nothing
 * behaviourally — and a future piece that makes a reference arm load-bearing in
 * the controller fails the standalone leg on its own PR.
 */
const REFERENCE_ARM_PRESENT = externalDataAllowed(rampGateMatrixMode());

const DECIDED: RampGateDecidedMeasurement = {
	thresholdRate: 0.02,
	toleranceValuePp: null,
	ownSample: 5_000,
	referenceSample: REFERENCE_ARM_PRESENT ? 5_000 : null,
	minSample: 200,
	ownRate: 0.005,
	referenceRate: REFERENCE_ARM_PRESENT ? 0.005 : null,
};

const HELD: RampGateHoldMeasurement = {
	thresholdRate: 0.02,
	toleranceValuePp: null,
	ownSample: 10,
	referenceSample: REFERENCE_ARM_PRESENT ? 10 : null,
	minSample: 200,
	ownRate: null,
	referenceRate: null,
};

/**
 * A gate's grade. HIGH and increase-justifying by default: these fixtures exist
 * to exercise the CONTROLLER, so the gate layer's own confidence asymmetry
 * (plan D14 — `gates.matrix.test.ts` owns it) must not silently turn a fixture's
 * clean window into a hold here.
 */
const GRADE = { confidence: 'high', mayJustifyIncrease: true } as const;

export function passing(gate: RampGateId): RampGateResult {
	return { ...GRADE, gate, status: 'pass', reason: 'within_threshold', measurement: DECIDED };
}

export function failing(gate: RampGateId): RampGateResult {
	return {
		...GRADE,
		gate,
		status: 'fail',
		reason: 'absolute_threshold_breached',
		measurement: { ...DECIDED, ownRate: 0.5 },
	};
}

export function halting(gate: RampGateId): RampGateResult {
	return {
		...GRADE,
		gate,
		status: 'halt',
		reason: 'halt_threshold_breached',
		measurement: { ...DECIDED, ownRate: 0.9 },
	};
}

export function holding(gate: RampGateId): RampGateResult {
	return {
		...GRADE,
		gate,
		status: 'insufficient_data',
		reason: 'own_sample_below_floor',
		measurement: HELD,
	};
}

const ALL_GATES: readonly RampGateId[] = [
	'hard_bounce',
	'deferral',
	'complaint',
	'engagement_ratio',
	'seed_placement',
];

/** Every gate green. */
export function cleanEvaluation(previousCleanStreak: number, now = NOW): RampGateEvaluation {
	return aggregateRampGates({
		perGate: ALL_GATES.map(passing),
		previousCleanStreak,
		now,
	});
}

/** Every gate green except `gate`, which fails (or halts). */
export function breachedEvaluation(
	gate: RampGateId,
	options: {
		readonly halt?: boolean;
		readonly previousCleanStreak?: number;
		readonly now?: number;
	} = {}
): RampGateEvaluation {
	const now = options.now ?? NOW;
	return aggregateRampGates({
		perGate: ALL_GATES.map((candidate) =>
			candidate === gate
				? options.halt === true
					? halting(gate)
					: failing(gate)
				: passing(candidate)
		),
		previousCleanStreak: options.previousCleanStreak ?? 3,
		now,
	});
}

/** Nothing measurable: every gate holding. */
export function thinEvaluation(previousCleanStreak: number, now = NOW): RampGateEvaluation {
	return aggregateRampGates({
		perGate: ALL_GATES.map(holding),
		previousCleanStreak,
		now,
	});
}

export const CLEAR_SIGNALS: RampHardStopSignals = {
	isSendingAllowed: true,
	isCircuitBreakerOpen: false,
	isPoolBlocklisted: false,
};

/** Capacity that never binds: no volume projected, so nothing to bound. */
export const OPEN_CAPACITY: RampCapacityInput = { kind: 'unconstrained' };

export function mixState(overrides: Partial<RampMixState> = {}): RampMixState {
	return {
		share: 0.02,
		phaseCeiling: 1,
		cleanStreak: 0,
		frozenUntil: undefined,
		freezeReason: undefined,
		freezeStartedAt: undefined,
		cooldownMs: undefined,
		greenSince: undefined,
		graduatedAt: undefined,
		// No counted window yet: the fixtures exercise the decision rules, and the
		// window spacing has its own suite.
		lastCountedAt: undefined,
		...overrides,
	};
}

export function controllerInput(overrides: Partial<RampControllerInput> = {}): RampControllerInput {
	return {
		cell: GMAIL_CAMPAIGN,
		config: RAMP_STREAM_CONFIGS.campaign,
		mix: mixState(),
		signals: CLEAR_SIGNALS,
		evaluation: cleanEvaluation(3),
		capacity: OPEN_CAPACITY,
		isKillSwitchEngaged: false,
		now: NOW,
		...overrides,
	};
}
