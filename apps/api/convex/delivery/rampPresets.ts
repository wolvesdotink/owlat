/**
 * THE PER-STREAM AGGRESSIVENESS PRESETS — the read half (plan D9, D14, P3-6).
 *
 * At most three rows per deployment, and USUALLY NONE: absence is the default,
 * not an unconfigured state. A deployment that has never opened the Controls
 * screen has no rows here and runs the shipped constants exactly — which is what
 * makes the preset additive rather than a fork of `RAMP_STREAM_CONFIGS`.
 *
 * THE FALLBACK IS THE IDENTITY PRESET, DELIBERATELY (plan D3).
 * An earlier revision of this module defaulted a STANDALONE deployment to
 * `conservative`, on the reasoning that a weaker engagement gate deserves a
 * slower ramp (plan D14). That reasoning is right, but it is ALREADY IMPLEMENTED
 * — by the substitution table, which answers a missing `reference_transport`
 * with `cleanWindowsRequired: 5` and `stepMultiplier: 0.5`
 * (`ramp/degradationMatrix.ts`). Defaulting to `conservative` here made the SAME
 * fact slow the SAME cell TWICE: the preset halved the step and the table halved
 * it again, so a standalone campaign cell advanced at a QUARTER step instead of
 * the half the plan specifies. The windows did not double-count (the table's
 * value is an absolute override) which is exactly why the bug was invisible in
 * one number and real in the other.
 *
 * So the division of labour is: the TABLE owns what an ABSENT INTEGRATION costs
 * (D3 — one substitution table, never a second mechanism agreeing with it), and
 * a PRESET owns what the OPERATOR CHOSE (D9). An operator who explicitly picks
 * `conservative` still stacks on top of the table's tightening, because that is
 * a deliberate instruction rather than an inference the system made twice.
 */

import type { RampPreset } from '@owlat/shared/deliverabilityIndependence';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { RampPresetsByStream } from './ramp/presetConfig';

export interface RampPresetContext {
	readonly presets: RampPresetsByStream;
	/** What a stream with no row of its own runs under. */
	readonly fallback: RampPreset;
}

/** One bounded index read plus the relay probe the dashboard already makes. */
export async function loadRampPresets(
	ctx: QueryCtx | MutationCtx,
	organizationId: string
): Promise<RampPresetContext> {
	const rows = await ctx.db
		.query('rampStreamPresets')
		.withIndex('by_org_stream', (q) => q.eq('organizationId', organizationId))
		.take(8); // three streams; the bound is a guard, not a page size
	const presets: RampPresetsByStream = {};
	for (const row of rows) presets[row.stream] = row.preset;
	// The identity preset, whatever the deployment shape: the substitution table
	// is the ONE place an absent integration changes a constant (see the module
	// note above). `defaultRampPreset` still exists for the SETUP/Controls UI,
	// which pre-selects `conservative` for a standalone operator to CHOOSE.
	return { presets, fallback: 'balanced' };
}
