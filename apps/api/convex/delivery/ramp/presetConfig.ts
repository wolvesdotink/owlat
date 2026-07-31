/**
 * THE PRESET, APPLIED — the one place a chosen aggressiveness turns into a
 * stream config (plan D9, P3-6).
 *
 * A SUBSTITUTION, NEVER A SECOND TABLE. `RAMP_STREAM_CONFIGS` remains the only
 * constant table in the ramp; a preset scales the additive step and adds clean
 * windows on top of K_CLEAN, and `balanced` is the identity — so a deployment
 * that has never opened the Controls screen runs byte-identical constants to the
 * ones it ran before this shipped, standalone or not.
 *
 * A PRESET IS THE OPERATOR'S CHOICE, NEVER AN INFERENCE ABOUT THE DEPLOYMENT.
 * What a STANDALONE deployment costs (K_CLEAN 3 -> 5, step halved) is the
 * SUBSTITUTION TABLE's answer and is applied by `./degradation.ts` — see the
 * note in `delivery/rampPresets.ts` for why defaulting the fallback to
 * `conservative` here made the same fact halve the same step twice. The
 * composition is pinned by fixture in
 * `__tests__/presetDegradationComposition.test.ts`.
 *
 * WHAT A PRESET CANNOT REACH, by the shape of `RampPresetTuning` rather than by
 * a rule someone has to remember: the multiplicative decrease, the share floor,
 * the cooldown ladder, the phase ceilings and every hard stop. There is no field
 * that could express any of them. Cheap to retreat, expensive to advance (plan
 * D9) is not negotiable by an operator preference.
 */

import { applyRampPreset, type RampPreset } from '@owlat/shared/deliverabilityIndependence';
import type { DeliverabilityStream } from '@owlat/shared/deliverabilityRouting';
import { percentagePoints, RAMP_STREAM_CONFIGS, type RampStreamConfig } from './gateConfig';

/** The preset chosen for each stream, or absent where nobody chose one. */
export type RampPresetsByStream = Partial<Record<DeliverabilityStream, RampPreset>>;

/**
 * The config one stream runs under.
 *
 * `fallback` is what a stream with no preset row runs, and it is a PARAMETER
 * rather than a constant so the Controls screen can preview a preset the
 * operator is considering without writing a row first. The controller passes
 * `balanced` — the identity — because an unconfigured deployment has chosen
 * nothing and only a choice belongs here.
 */
export function rampConfigForStream(
	stream: DeliverabilityStream,
	presets: RampPresetsByStream,
	fallback: RampPreset
): RampStreamConfig {
	const base = RAMP_STREAM_CONFIGS[stream];
	const preset = presets[stream] ?? fallback;
	const tuned = applyRampPreset(
		{ increaseStep: base.increaseStep, cleanWindowsRequired: base.cleanWindowsRequired },
		preset
	);
	return {
		...base,
		increaseStep: percentagePoints(tuned.increaseStep),
		// A fractional window count would compare a whole streak against a half
		// window for ever. Rounded UP: a preset that asks for more evidence gets it.
		cleanWindowsRequired: Math.ceil(tuned.cleanWindowsRequired),
	};
}
