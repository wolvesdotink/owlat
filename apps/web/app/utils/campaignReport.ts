/**
 * Campaign report — pure helpers for the "compared with the previous campaign"
 * row. No Vue, no Convex: everything here is unit-tested directly.
 *
 * The report page fetches a bounded window of recent SENT campaign snapshots
 * (`api.campaigns.analytics.getComparableSentCampaigns`) and runs these two
 * functions client-side: pick the prior comparable send, then diff its rates
 * against the current send. Changes are expressed in percentage POINTS of the
 * rate (not raw counts) so audiences of different sizes compare fairly.
 */

/** The aggregated counts the comparison row diffs. */
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

/** Performance direction of a change — "up" always reads as an improvement. */
export type DeltaDirection = 'up' | 'down' | 'flat';

/** The two rates the report compares against the previous campaign. */
export type ComparedRate = 'openRate' | 'clickRate';

export interface RateComparison {
	key: ComparedRate;
	/** This send's rate as a fraction (0.384 = 38.4%). */
	rate: number;
	/**
	 * Change against the previous campaign in percentage POINTS, rounded to one
	 * decimal, or null when there is no previous campaign to compare with.
	 */
	pointsChange: number | null;
	direction: DeltaDirection;
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

/** Rate as a fraction, guarding a zero denominator. */
function rate(numerator: number, denominator: number): number {
	return denominator > 0 ? numerator / denominator : 0;
}

function compare(key: ComparedRate, current: number, previous: number | null): RateComparison {
	if (previous === null) return { key, rate: current, pointsChange: null, direction: 'flat' };
	// Rounded before the sign test so "+0.0 pts" can never read as a change.
	// `|| 0` folds a rounded -0 into 0.
	const pointsChange = Math.round((current - previous) * 1000) / 10 || 0;
	return {
		key,
		rate: current,
		pointsChange,
		direction: pointsChange > 0 ? 'up' : pointsChange < 0 ? 'down' : 'flat',
	};
}

/**
 * The report's one comparison row: open rate and click rate (both of
 * delivered) for this send, each with its change in percentage points against
 * the previous comparable campaign. Counts are deliberately left out — a
 * points change only means something for a rate, and audiences of different
 * sizes make a raw count change meaningless.
 */
export function compareRates(
	current: CampaignStatSnapshot,
	previous: CampaignStatSnapshot | null
): RateComparison[] {
	return [
		compare(
			'openRate',
			rate(current.opened, current.delivered),
			previous ? rate(previous.opened, previous.delivered) : null
		),
		compare(
			'clickRate',
			rate(current.clicked, current.delivered),
			previous ? rate(previous.clicked, previous.delivered) : null
		),
	];
}
