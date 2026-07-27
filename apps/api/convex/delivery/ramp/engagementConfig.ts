/**
 * Gate 4 — engagement ratio: THE SUBSTITUTION TABLE AND THE CONSTANTS.
 *
 * Two policies live here, both deliberately data rather than control flow:
 *
 * 1. WHICH ENGAGEMENT METRIC A MAILBOX PROVIDER IS GATED ON. Apple Mail Privacy
 *    Protection pre-fetches the tracking pixel for every message, so an Apple
 *    cell's open rate is a measurement of Apple's proxy and not of our
 *    deliverability; the cell is gated on CLICKS instead. Gmail proxies images
 *    too, but it does so on open rather than on receipt, so opens there stay
 *    informative — and, crucially, whatever inflation a provider applies is
 *    roughly constant WITHIN a cell, so it largely cancels in a ratio between
 *    two arms of the same cell.
 *
 *    That makes the metric a per-cell CONFIGURATION rather than an
 *    `if (provider === 'apple')` buried in the arithmetic (Fowler: Repeated
 *    Switches). One table, overridable per evaluation, so a future provider
 *    change is a data edit.
 *
 * 2. HOW MUCH MOVEMENT IS TOLERATED. The ratio threshold and the slow-poison
 *    floor. Both are quoted as RELATIVE numbers — a ratio of two rates — never
 *    as an absolute open rate, which moves with subject line, audience and
 *    season and is worthless as a deliverability signal.
 */

import type { DestinationProviderKey } from '@owlat/shared/deliverabilityRouting';

/** The engagement signal a cell is gated on. */
export type EngagementMetric = 'open' | 'click';

/**
 * The substitution table. Every mailbox provider is named explicitly — a
 * `Record` over the full key union, so adding a destination provider to
 * `DESTINATION_PROVIDER_KEYS` fails to compile here until someone decides
 * whether its opens mean anything.
 */
export const ENGAGEMENT_METRIC_BY_PROVIDER: Readonly<
	Record<DestinationProviderKey, EngagementMetric>
> = {
	gmail: 'open',
	microsoft: 'open',
	yahoo: 'open',
	// MPP pre-fetches every pixel: opens here measure Apple, not us.
	apple: 'click',
	other: 'open',
};

/** Per-evaluation overrides of the table above. Absent keys fall back to it. */
export type EngagementMetricOverrides = Readonly<
	Partial<Record<DestinationProviderKey, EngagementMetric>>
>;

export function resolveEngagementMetric(
	provider: DestinationProviderKey,
	overrides?: EngagementMetricOverrides
): EngagementMetric {
	return overrides?.[provider] ?? ENGAGEMENT_METRIC_BY_PROVIDER[provider];
}

export interface EngagementGateThresholds {
	/**
	 * Gate 4's ratio floor: `ownRate / referenceRate` must be at least this.
	 *
	 * A RATIO, not a rate — the two are both small numbers and the measurement
	 * carries it in `thresholdRate`, so the doc comment is the only thing that
	 * keeps them apart. 0.95 means "the own arm may engage up to 5% RELATIVELY
	 * worse than the reference arm over the same send".
	 */
	readonly minRatio: number;
	/**
	 * The slow-poison floor: this window's engagement, as a ratio of the cell's
	 * own 30-day trailing engagement.
	 *
	 * Deliberately wide (plan D14). A redesigned newsletter that engages 20%
	 * worse is indistinguishable from a 20% placement loss, so a floor that
	 * fires on small moves would retreat the ramp for editorial reasons. 0.7
	 * catches the LARGE, smooth decay that every concurrent gate passes, which
	 * is the only thing this check exists for.
	 */
	readonly absoluteFloorRatio: number;
	/**
	 * Calibration sends the 30-day trailing baseline must carry before the floor
	 * check may decide. Roughly three weekly windows: a baseline thinner than
	 * that is noise, and comparing against noise would retreat a healthy cell.
	 */
	readonly baselineMinSample: number;
}

export const ENGAGEMENT_GATE_THRESHOLDS: EngagementGateThresholds = {
	minRatio: 0.95,
	absoluteFloorRatio: 0.7,
	baselineMinSample: 1200,
};
