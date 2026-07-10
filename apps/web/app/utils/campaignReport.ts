/**
 * Campaign report — pure helpers for the "delta vs previous comparable send"
 * hero tiles. No Vue, no Convex: everything here is unit-tested directly.
 *
 * The report page fetches a bounded window of recent SENT campaign snapshots
 * (`api.campaigns.analytics.getComparableSentCampaigns`) and runs these two
 * functions client-side: pick the prior comparable send, then diff its rates
 * against the current send. Deltas are expressed in percentage POINTS of the
 * relevant rate (not raw counts) so audiences of different sizes compare fairly.
 */

/** The aggregated counts a report tile diffs. */
export interface CampaignStatSnapshot {
	/** Everything dispatched to the provider. */
	sent: number;
	/** Recipients who ever reached delivered (the rate denominator). */
	delivered: number;
	/** Unique opens. */
	opened: number;
	/** Unique clicks. */
	clicked: number;
	/** Bounces. */
	bounced: number;
}

/** A candidate prior send returned by `getComparableSentCampaigns`. */
export interface ComparableCampaign extends CampaignStatSnapshot {
	id: string;
	name: string;
	sentAt: number;
	isABTest: boolean;
}

/** Identity of the campaign currently on screen. */
export interface CurrentComparable {
	id: string;
	sentAt: number;
	isABTest: boolean;
}

/** Performance direction of a delta — "up" always reads as an improvement. */
export type DeltaDirection = 'up' | 'down' | 'flat';

export interface StatDelta {
	/** Formatted magnitude (e.g. "2.3 pts"), or null when there is no prior send. */
	text: string | null;
	direction: DeltaDirection;
}

export interface CampaignStatDeltas {
	delivered: StatDelta;
	opened: StatDelta;
	clicked: StatDelta;
	bounced: StatDelta;
}

/**
 * The org's prior comparable send: the most recent OTHER sent campaign of the
 * same kind (A/B vs regular) that went out before this one. Returns null when
 * there is no such campaign.
 */
export function selectPreviousComparable(
	candidates: readonly ComparableCampaign[],
	current: CurrentComparable
): ComparableCampaign | null {
	let best: ComparableCampaign | null = null;
	for (const c of candidates) {
		if (c.id === current.id) continue;
		if (c.isABTest !== current.isABTest) continue;
		if (c.sentAt >= current.sentAt) continue;
		if (best === null || c.sentAt > best.sentAt) best = c;
	}
	return best;
}

/** Percentage rate, guarding a zero denominator. */
function rate(numerator: number, denominator: number): number {
	return denominator > 0 ? (numerator / denominator) * 100 : 0;
}

/**
 * Percentage-point delta between the current and previous rate. `higherIsBetter`
 * flips the direction so an improvement always reads as "up" (fewer bounces is
 * an improvement, so bounce rate passes `false`).
 */
function pointDelta(currentRate: number, previousRate: number, higherIsBetter: boolean): StatDelta {
	const diff = Math.round((currentRate - previousRate) * 10) / 10;
	if (diff === 0) return { text: '0.0 pts', direction: 'flat' };
	const improved = higherIsBetter ? diff > 0 : diff < 0;
	return { text: `${Math.abs(diff).toFixed(1)} pts`, direction: improved ? 'up' : 'down' };
}

const noDelta: StatDelta = { text: null, direction: 'flat' };

/**
 * The all-empty delta set — every metric has no prior send to compare against.
 * Returned by `computeStatDeltas` when there is no previous comparable send, and
 * usable directly (e.g. before the current send's stats have loaded).
 */
export const NO_DELTAS: CampaignStatDeltas = {
	delivered: noDelta,
	opened: noDelta,
	clicked: noDelta,
	bounced: noDelta,
};

/**
 * Per-metric deltas of the current send vs the previous comparable send. When
 * `previous` is null (no prior comparable send) every delta is empty.
 */
export function computeStatDeltas(
	current: CampaignStatSnapshot,
	previous: CampaignStatSnapshot | null
): CampaignStatDeltas {
	if (previous === null) {
		return NO_DELTAS;
	}
	return {
		delivered: pointDelta(
			rate(current.delivered, current.sent),
			rate(previous.delivered, previous.sent),
			true
		),
		opened: pointDelta(
			rate(current.opened, current.delivered),
			rate(previous.opened, previous.delivered),
			true
		),
		clicked: pointDelta(
			rate(current.clicked, current.delivered),
			rate(previous.clicked, previous.delivered),
			true
		),
		bounced: pointDelta(
			rate(current.bounced, current.sent),
			rate(previous.bounced, previous.sent),
			false
		),
	};
}
