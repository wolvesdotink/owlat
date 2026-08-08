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
 * at the winning rank, and the sources are folded in the plan's gate numbering
 * (1 hard bounce, 2 deferral, 3 complaint, 4 engagement ratio, 5 seed
 * placement), so the earliest, most fundamental problem is the one reported.
 * That order is `RAMP_GATE_SIGNAL_KEYS`' own — the KEYS come from the shared
 * vocabulary, but their SEQUENCE is declared in `./types` and is the ramp's, not
 * shared's (shared's outcome list neither contains `persistent_defers` nor is in
 * gate order). Re-ordering that one array re-orders which breach an operator is
 * shown; re-ordering anything in `@owlat/shared` does not.
 *
 * REGISTRATION IS NOT REMEMBERED, IT IS CHECKED. The measurements are a RECORD
 * keyed by the vocabulary and the fold is derived from it, so a declared key
 * with no source does not compile; `_EveryRampGateIsFolded` closes the other
 * direction, so a `RampGateId` nothing measures does not compile either.
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
	RAMP_GATE_SIGNAL_KEYS,
	signalAbsent,
	signalPresent,
	type RampGateSignalKey,
	type SignalAbsence,
	type SignalSource,
	type SignalSourceKind,
} from './types';

/** Which evaluator arm is asking — the two implementations of plan D3. */
export type RampArm = RampGateEvaluator['kind'];

/**
 * The families a RAMP measurement can belong to — the registry's three minus
 * `advisory`, because folding a reading is precisely what advisory means it may
 * not do. Derived from `SignalSourceKind` rather than spelled out, so renaming a
 * family in `./types` stops compiling here instead of forking the ramp's union
 * from the registry's.
 */
export type RampMeasurementKind = Exclude<SignalSourceKind, 'advisory'>;

/** One arm's question about one window. */
export interface RampGateSignalInput {
	readonly arm: RampArm;
	readonly input: RampGateEvaluationInput;
}

/**
 * A ramp measurement as a signal source, narrowed to the families a ramp
 * measurement can belong to (see `RampMeasurementKind`).
 */
export interface RampGateSignalSource extends SignalSource<RampGateSignalInput, RampGateResult> {
	readonly key: RampGateSignalKey;
	readonly kind: RampMeasurementKind;
	/** The ramp's own id for this measurement — the audit and notification key. */
	readonly gate: RampGateId;
}

interface RampGateSignalSpecBase<Gate extends RampGateId> {
	readonly key: RampGateSignalKey;
	readonly gate: Gate;
	readonly kind: RampMeasurementKind;
}

/**
 * A SOURCE THAT DOES NOT ANSWER IS A SOURCE THAT DECLARED `omit`, and the
 * compiler is what says so.
 *
 * `null` from an evaluator means THIS WINDOW MEASURED NOTHING: `collect()` hands
 * back the declared absence and `collectRampGateSignals` folds nothing at all.
 * For a source that declared `hold` that would be a silent contradiction — the
 * hold exists precisely so the aggregator has a result to weigh above `pass`
 * (plan D10), and a gate that vanished instead would let a cell's clean streak
 * grow on a window the gate never graded. So the spec is DISCRIMINATED on the
 * declared behaviour: only the `omit` arm may return `null`, and a `hold` source
 * whose evaluator learns to return `null` stops compiling here rather than
 * quietly disappearing from the fold.
 */
type RampGateSignalSpec<Gate extends RampGateId = RampGateId> = RampGateSignalSpecBase<Gate> &
	(
		| {
				readonly absence: Extract<SignalAbsence, { behaviour: 'omit' }>;
				readonly evaluate: Readonly<
					Record<RampArm, (input: RampGateEvaluationInput) => RampGateResult | null>
				>;
		  }
		| {
				readonly absence: Exclude<SignalAbsence, { behaviour: 'omit' }>;
				readonly evaluate: Readonly<
					Record<RampArm, (input: RampGateEvaluationInput) => RampGateResult>
				>;
		  }
	);

function rampGateSignalSource<Gate extends RampGateId>(
	spec: RampGateSignalSpec<Gate>
): RampGateSignalSource & { readonly gate: Gate } {
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
const COUNTER_ABSENCE = (measurement: string): Extract<SignalAbsence, { behaviour: 'hold' }> => ({
	behaviour: 'hold',
	note: `A window with no ${measurement} to compare answers insufficient_data, which holds the ramp where it is — never a pass, and never a retreat.`,
	isBlocking: false,
});

/**
 * THE MEASUREMENTS, KEYED BY THE SHARED VOCABULARY.
 *
 * A RECORD RATHER THAN A LIST, because a list is exactly the thing this module
 * was written to delete: an array can be short by one and still compile, which
 * is the failure the two hand-written sequences in `gateEvaluation.ts` had and
 * the one worth closing. Keyed by `RampGateSignalKey`, a sixth measurement in
 * the vocabulary does not compile until a source for it is declared HERE, and
 * the assertion below closes the other end — a sixth `RampGateId` does not
 * compile until it is folded.
 */
export const RAMP_GATE_SIGNALS = {
	bounce_rate: rampGateSignalSource({
		key: 'bounce_rate',
		gate: 'hard_bounce',
		kind: 'outcome',
		absence: COUNTER_ABSENCE('hard bounces'),
		evaluate: {
			reference_arm: evaluateHardBounceGate,
			trailing_baseline: evaluateTrailingHardBounceGate,
		},
	}),

	persistent_defers: rampGateSignalSource({
		key: 'persistent_defers',
		gate: 'deferral',
		kind: 'infrastructure',
		absence: COUNTER_ABSENCE('deferrals'),
		evaluate: {
			reference_arm: evaluateDeferralGate,
			trailing_baseline: evaluateStandaloneDeferralGate,
		},
	}),

	complaint_rate: rampGateSignalSource({
		key: 'complaint_rate',
		gate: 'complaint',
		kind: 'outcome',
		absence: COUNTER_ABSENCE('complaints'),
		evaluate: {
			reference_arm: evaluateComplaintGate,
			trailing_baseline: evaluateStandaloneComplaintGate,
		},
	}),

	/**
	 * Gate 4 is computed elsewhere (it carries the MPP handling) and arrives on
	 * the input, so absent means "not measured this window" and contributes
	 * NOTHING — deliberately not a hold. Holding here would freeze every cell that
	 * has not yet accumulated its calibration sends, turning an absent weak signal
	 * into a blocker, which is the one thing plan D2 forbids it from being.
	 *
	 * The standalone arm RE-GRADES the pre-computed result to the weak trailing
	 * signal, so the concurrent ratio's high-confidence, increase-justifying
	 * verdict cannot be smuggled into a deployment that has no second arm to have
	 * measured it with.
	 */
	engagement_ratio: rampGateSignalSource({
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
	}),

	/**
	 * Gate 5 answers on every window, including the windows it could not measure —
	 * a cell with no classified probes gets its hold. That the hold then costs the
	 * ramp NO GATE BREACH is the OPTIONAL-gate rule, and that rule has one home
	 * (`OPTIONAL_RAMP_GATES` in `ramp/gateConfig.ts`) which this note deliberately
	 * points at rather than restates.
	 *
	 * It is not the same claim as "having no seed mailboxes is free": a deployment
	 * with nowhere to land probes pays at the ramp level, and that price is the
	 * `seed_mailboxes` entry in `../ramp/degradationMatrix` — the other plane, the
	 * one `SignalAbsence` deliberately does not speak for.
	 */
	seed_placement: rampGateSignalSource({
		key: 'seed_placement',
		gate: 'seed_placement',
		kind: 'outcome',
		absence: {
			behaviour: 'hold',
			note: 'A cell with no classified probes answers insufficient_data; because seed placement is one of OPTIONAL_RAMP_GATES that hold is not itself a gate breach.',
			isBlocking: false,
		},
		evaluate: {
			reference_arm: evaluateSeedPlacementGate,
			trailing_baseline: evaluateStandaloneSeedPlacementGate,
		},
	}),
} satisfies Readonly<Record<RampGateSignalKey, RampGateSignalSource>>;

/**
 * EVERY RAMP GATE IS FOLDED — the direction that hurts, checked by the compiler.
 *
 * The record above stops a declared KEY from going unregistered. This stops a
 * declared GATE from going unmeasured: add a sixth `RampGateId` and forget this
 * module, and `aggregateRampGates` would grow its clean streak on a measurement
 * nothing ever took. Both evaluators fold this one list, so an omission here is
 * an omission everywhere.
 */
type UnfoldedRampGate = Exclude<RampGateId, (typeof RAMP_GATE_SIGNALS)[RampGateSignalKey]['gate']>;
type AssertEveryRampGateIsFolded<_T extends never> = true;
export type _EveryRampGateIsFolded = AssertEveryRampGateIsFolded<UnfoldedRampGate>;

/**
 * The five measurements, in the plan's gate numbering. ORDER IS CONTRACT, and it
 * is `RAMP_GATE_SIGNAL_KEYS`' order (declared in `./types`) rather than a second
 * hand-written sequence: the aggregator names the FIRST result at the winning
 * rank, so re-ordering that array — and only that array — re-orders which breach
 * an operator is shown.
 */
export const RAMP_GATE_SIGNAL_SOURCES: readonly RampGateSignalSource[] = RAMP_GATE_SIGNAL_KEYS.map(
	(key) => RAMP_GATE_SIGNALS[key]
);

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
