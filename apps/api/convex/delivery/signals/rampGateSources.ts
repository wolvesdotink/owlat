/**
 * THE RAMP'S OWN SIGNAL SOURCES — the five measurements gate evaluation folds,
 * declared once as data instead of being named module by module inside each
 * evaluator (seams plan D9).
 *
 * WHAT MOVED HERE AND WHAT DID NOT. The gates themselves did not move: the
 * comparisons still live in `ramp/gates.ts`, `ramp/seedGate.ts` and
 * `ramp/trailingBaselineGates.ts`, and this module changes none of them. What
 * moved is the LIST — which measurements exist, in which order they are folded,
 * which arm evaluates each, and what each does when its evidence is absent.
 * `ramp/gateEvaluation.ts` used to hold that list twice, once per arm, as two
 * hand-written sequences of imported function calls; a sixth measurement had to
 * be remembered in both, and neither sequence said what an absent one meant.
 *
 * ORDER IS PART OF THE DECLARATION. `aggregateRampGates` names the FIRST result
 * at the winning rank, and the sources are declared in the plan's gate numbering
 * (1 hard bounce, 2 deferral, 3 complaint, 4 engagement ratio, 5 seed
 * placement), so the earliest, most fundamental problem is the one reported.
 * Re-ordering this array re-orders which breach an operator is shown.
 *
 * TWO ARMS, ONE LIST. Each source declares an evaluator per arm — the concurrent
 * two-armed one and the standalone trailing-baseline twin (plan D3). That is the
 * one place the two implementations differ: WHICH second series a measurement
 * compares against, never which measurements exist or how their answers fold.
 * A source with no evaluator for an arm is unrepresentable, so the standalone
 * deployment cannot silently lose a gate.
 *
 * KEYS COME FROM THE SHARED VOCABULARY, not from `RampGateId`: `bounce_rate`,
 * `complaint_rate`, `engagement_ratio` and `seed_placement` are the shared
 * OUTCOME sources and `persistent_defers` is a shared INFRASTRUCTURE source, and
 * that correspondence — the ramp measures exactly the signals the routing
 * vocabulary declares — was until now nowhere written down. `gate` carries the
 * ramp's own id alongside it, because that is what the audit row and the
 * operator notification key off (plan D12).
 */

import { evaluateComplaintGate, evaluateDeferralGate, evaluateHardBounceGate } from '../ramp/gates';
import { evaluateSeedPlacementGate, evaluateStandaloneSeedPlacementGate } from '../ramp/seedGate';
import {
	asTrailingEngagement,
	evaluateStandaloneComplaintGate,
	evaluateStandaloneDeferralGate,
	evaluateTrailingHardBounceGate,
} from '../ramp/trailingBaselineGates';
import type {
	RampGateEvaluationInput,
	RampGateEvaluator,
	RampGateId,
	RampGateResult,
} from '../ramp/gateTypes';
import {
	signalAbsent,
	signalPresent,
	type RampGateSignalKey,
	type SignalAbsence,
	type SignalSource,
} from './types';

/** Which evaluator arm is asking — the two implementations of plan D3. */
export type RampArm = RampGateEvaluator['kind'];

/** One arm's question about one window. */
export interface RampGateSignalInput {
	readonly arm: RampArm;
	readonly input: RampGateEvaluationInput;
}

/**
 * A ramp measurement as a signal source. `kind` is narrowed to the two families
 * a ramp measurement can belong to: nothing the controller folds is advisory,
 * because folding it is precisely what advisory means it may not do.
 */
export interface RampGateSignalSource extends SignalSource<RampGateSignalInput, RampGateResult> {
	readonly key: RampGateSignalKey;
	readonly kind: 'infrastructure' | 'outcome';
	/** The ramp's own id for this measurement — the audit and notification key. */
	readonly gate: RampGateId;
}

interface RampGateSignalSpec {
	readonly key: RampGateSignalKey;
	readonly gate: RampGateId;
	readonly kind: 'infrastructure' | 'outcome';
	readonly absence: SignalAbsence;
	/**
	 * The evaluator per arm. `null` means THIS WINDOW MEASURED NOTHING and the
	 * source contributes no result at all — which is only ever correct for a
	 * source whose declared absence is `omit`, since a source that holds must
	 * hand back the holding result for the aggregator to weigh.
	 */
	readonly evaluate: Readonly<
		Record<RampArm, (input: RampGateEvaluationInput) => RampGateResult | null>
	>;
}

function rampGateSignalSource(spec: RampGateSignalSpec): RampGateSignalSource {
	return {
		key: spec.key,
		gate: spec.gate,
		kind: spec.kind,
		absence: spec.absence,
		collect({ arm, input }: RampGateSignalInput) {
			const result = spec.evaluate[arm](input);
			return result === null ? signalAbsent(spec.absence) : signalPresent(result);
		},
	};
}

/**
 * The three counter-driven gates hold rather than omit: they always answer, and
 * "no evidence this window" is that answer's `insufficient_data`, which the
 * aggregator weighs above `pass` so the ramp never advances on nothing (D10).
 */
const COUNTER_ABSENCE = (measurement: string): SignalAbsence => ({
	behaviour: 'hold',
	note: `A window with no ${measurement} to compare answers insufficient_data, which holds the ramp where it is — never a pass, and never a retreat.`,
	isBlocking: false,
});

export const HARD_BOUNCE_SIGNAL = rampGateSignalSource({
	key: 'bounce_rate',
	gate: 'hard_bounce',
	kind: 'outcome',
	absence: COUNTER_ABSENCE('hard bounces'),
	evaluate: {
		reference_arm: evaluateHardBounceGate,
		trailing_baseline: evaluateTrailingHardBounceGate,
	},
});

export const DEFERRAL_SIGNAL = rampGateSignalSource({
	key: 'persistent_defers',
	gate: 'deferral',
	kind: 'infrastructure',
	absence: COUNTER_ABSENCE('deferrals'),
	evaluate: {
		reference_arm: evaluateDeferralGate,
		trailing_baseline: evaluateStandaloneDeferralGate,
	},
});

export const COMPLAINT_SIGNAL = rampGateSignalSource({
	key: 'complaint_rate',
	gate: 'complaint',
	kind: 'outcome',
	absence: COUNTER_ABSENCE('complaints'),
	evaluate: {
		reference_arm: evaluateComplaintGate,
		trailing_baseline: evaluateStandaloneComplaintGate,
	},
});

/**
 * Gate 4 is computed elsewhere (it carries the MPP handling) and arrives on the
 * input, so absent means "not measured this window" and contributes NOTHING —
 * deliberately not a hold. Holding here would freeze every cell that has not yet
 * accumulated its calibration sends, turning an absent weak signal into a
 * blocker, which is the one thing plan D2 forbids it from being.
 *
 * The standalone arm RE-GRADES the pre-computed result to the weak trailing
 * signal, so the concurrent ratio's high-confidence, increase-justifying verdict
 * cannot be smuggled into a deployment that has no second arm to have measured
 * it with.
 */
export const ENGAGEMENT_SIGNAL = rampGateSignalSource({
	key: 'engagement_ratio',
	gate: 'engagement_ratio',
	kind: 'outcome',
	absence: {
		behaviour: 'omit',
		note: 'A window with no engagement ratio contributes nothing at all: an absent weak signal must never be able to hold a cell.',
		isBlocking: false,
	},
	evaluate: {
		reference_arm: (input) => input.engagement ?? null,
		trailing_baseline: (input) =>
			input.engagement ? asTrailingEngagement(input.engagement) : null,
	},
});

/**
 * Gate 5 answers on every window, including the windows it could not measure —
 * a cell with no classified probes gets its hold. That the hold then costs the
 * ramp nothing is the OPTIONAL-gate rule, and that rule has one home
 * (`OPTIONAL_RAMP_GATES` in `ramp/gateConfig.ts`) which this note deliberately
 * points at rather than restates.
 */
export const SEED_PLACEMENT_SIGNAL = rampGateSignalSource({
	key: 'seed_placement',
	gate: 'seed_placement',
	kind: 'outcome',
	absence: {
		behaviour: 'hold',
		note: 'A cell with no classified probes answers insufficient_data; because seed placement is one of OPTIONAL_RAMP_GATES that hold costs the ramp nothing.',
		isBlocking: false,
	},
	evaluate: {
		reference_arm: evaluateSeedPlacementGate,
		trailing_baseline: evaluateStandaloneSeedPlacementGate,
	},
});

/** The five measurements, in the plan's gate numbering. Order is contract. */
export const RAMP_GATE_SIGNAL_SOURCES: readonly RampGateSignalSource[] = [
	HARD_BOUNCE_SIGNAL,
	DEFERRAL_SIGNAL,
	COMPLAINT_SIGNAL,
	ENGAGEMENT_SIGNAL,
	SEED_PLACEMENT_SIGNAL,
];

/**
 * Fold one arm's window into the per-gate results the aggregator weighs.
 *
 * Sources that measured nothing are omitted rather than represented, which is
 * the aggregator's own contract: an evaluation nothing contributed to is
 * evidence-free, and evidence-free is exactly the state `pass` is unreachable
 * from.
 */
export function collectRampGateSignals(
	arm: RampArm,
	input: RampGateEvaluationInput
): RampGateResult[] {
	const results: RampGateResult[] = [];
	for (const source of RAMP_GATE_SIGNAL_SOURCES) {
		const collected = source.collect({ arm, input });
		if (collected.available) results.push(collected.reading);
	}
	return results;
}
