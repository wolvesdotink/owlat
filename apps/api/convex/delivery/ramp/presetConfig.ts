/**
 * THE PRESET, APPLIED — the one place a chosen aggressiveness turns into a
 * stream config (plan D9, P3-6).
 *
 * A SUBSTITUTION, NEVER A SECOND TABLE. `RAMP_STREAM_CONFIGS` remains the only
 * constant table in the ramp; a preset scales the additive step and adds clean
 * windows on top of K_CLEAN, and `balanced` is the identity — so a deployment
 * that has never opened the Controls screen runs byte-identical constants to the
 * ones it ran before this shipped.
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
 * `fallback` is the deployment's default (plan D14: `conservative` standalone,
 * `balanced` with a relay) and is a PARAMETER rather than a lookup, because the
 * thing that decides it — whether a reference transport exists — is a database
 * read the caller has already made and this module must never make.
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
