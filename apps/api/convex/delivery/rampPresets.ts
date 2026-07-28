/**
 * THE PER-STREAM AGGRESSIVENESS PRESETS — the read half (plan D9, D14, P3-6).
 *
 * At most three rows per deployment, and USUALLY NONE: absence is the default,
 * not an unconfigured state. A deployment that has never opened the Controls
 * screen has no rows here and runs the shipped constants exactly — which is what
 * makes the preset additive rather than a fork of `RAMP_STREAM_CONFIGS`.
 *
 * THE DEFAULT IS A JUDGEMENT ABOUT EVIDENCE, NOT ABOUT NERVE (plan D14).
 * Standalone deployments default to `conservative` because their engagement gate
 * is genuinely the weaker signal — a redesigned newsletter that opens 20% worse
 * is indistinguishable from a 20% placement loss — and the honest response to
 * weaker evidence is to advance more slowly. It is never presented as a degraded
 * mode, and it never blocks anything.
 */

import { defaultRampPreset, type RampPreset } from '@owlat/shared/deliverabilityIndependence';
import type { QueryCtx } from '../_generated/server';
import { referenceRelayTransportId } from './alignmentPreflight';
import type { RampPresetsByStream } from './ramp/presetConfig';

export interface RampPresetContext {
	readonly presets: RampPresetsByStream;
	/** What a stream with no row of its own runs under. */
	readonly fallback: RampPreset;
}

/** One bounded index read plus the relay probe the dashboard already makes. */
export async function loadRampPresets(
	ctx: QueryCtx,
	organizationId: string
): Promise<RampPresetContext> {
	const rows = await ctx.db
		.query('rampStreamPresets')
		.withIndex('by_org_stream', (q) => q.eq('organizationId', organizationId))
		.take(8); // three streams; the bound is a guard, not a page size
	const presets: RampPresetsByStream = {};
	for (const row of rows) presets[row.stream] = row.preset;
	const referenceTransportId = await referenceRelayTransportId(ctx);
	return { presets, fallback: defaultRampPreset(referenceTransportId !== null) };
}
