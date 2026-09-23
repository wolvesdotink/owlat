/**
 * The one-sentence campaign headline — "Best click rate in 6 campaigns." — written
 * by a template from the numbers, never by a model.
 *
 * Two surfaces read it: the Marketing overview's latest-campaign cards and the
 * top of the campaign report. Both hand over a campaign's rates plus the recent
 * sends it is judged against; `headlineVerdict` picks the single most telling
 * comparison, and each surface turns that verdict into a message key of its own
 * (the report sentence also quotes the rates). Being module scope it cannot call
 * `useI18n`, so the copy travels as message KEYS plus params and the component
 * translates them.
 *
 * All rates are fractions (0–1).
 */

export interface CampaignRates {
	openRate: number;
	clickRate: number;
	unsubscribeRate: number;
}

export interface RatedCampaign extends CampaignRates {
	id: string;
}

export type HeadlineKind =
	| 'bestClick'
	| 'bestOpen'
	| 'highUnsubscribe'
	| 'belowOpen'
	| 'belowClick'
	| 'aboveOpen'
	| 'aboveClick'
	| 'onPar';

export interface HeadlineVerdict {
	kind: HeadlineKind;
	/** For the "best in N" kinds: how many campaigns the run covers, this one included. */
	count?: number;
}

export interface HeadlineMessage {
	key: string;
	params: Record<string, string | number>;
}

/** A "best in N" claim needs at least this many campaigns to mean anything. */
const MIN_STREAK = 3;
/** Open-rate gap to the average, in fraction points, that is worth a sentence. */
const OPEN_GAP = 0.03;
/** Click-rate gap to the average that is worth a sentence (click rates run lower). */
const CLICK_GAP = 0.01;
/** Unsubscribes read as high only at twice the average AND this absolute gap. */
const UNSUBSCRIBE_GAP = 0.002;

type Metric = 'openRate' | 'clickRate';

/**
 * How many consecutive campaigns, counting back from `history[index]` and
 * including it, this campaign's `metric` is at least as good as. `history` is
 * oldest first.
 */
export function bestRun(history: readonly CampaignRates[], index: number, metric: Metric): number {
	const target = history[index];
	if (!target) return 0;
	let run = 1;
	for (let i = index - 1; i >= 0; i--) {
		if (history[i]![metric] > target[metric]) break;
		run++;
	}
	return run;
}

/**
 * The single most telling comparison for `target` against `history` (oldest
 * first, `target` included) and the `average` over that history. Returns
 * `null` when there is nothing to judge: the campaign is not in the history,
 * or it is the only send so far.
 *
 * Precedence: a record (best click, then best open) beats a warning (high
 * unsubscribes), which beats a gap to the average (below before above, open
 * before click), which beats "in line with your average".
 */
export function headlineVerdict(
	targetId: string,
	history: readonly RatedCampaign[],
	average: CampaignRates
): HeadlineVerdict | null {
	const index = history.findIndex((c) => c.id === targetId);
	if (index < 0 || history.length < 2) return null;
	const target = history[index]!;

	const clickRun = bestRun(history, index, 'clickRate');
	if (clickRun >= MIN_STREAK && target.clickRate > 0) return { kind: 'bestClick', count: clickRun };
	const openRun = bestRun(history, index, 'openRate');
	if (openRun >= MIN_STREAK && target.openRate > 0) return { kind: 'bestOpen', count: openRun };

	if (
		target.unsubscribeRate >= 2 * average.unsubscribeRate &&
		target.unsubscribeRate - average.unsubscribeRate >= UNSUBSCRIBE_GAP
	) {
		return { kind: 'highUnsubscribe' };
	}

	const openGap = target.openRate - average.openRate;
	const clickGap = target.clickRate - average.clickRate;
	if (openGap <= -OPEN_GAP) return { kind: 'belowOpen' };
	if (clickGap <= -CLICK_GAP) return { kind: 'belowClick' };
	if (openGap >= OPEN_GAP) return { kind: 'aboveOpen' };
	if (clickGap >= CLICK_GAP) return { kind: 'aboveClick' };
	return { kind: 'onPar' };
}

function paramsOf(verdict: HeadlineVerdict): Record<string, string | number> {
	return verdict.count === undefined ? {} : { count: verdict.count };
}

/** The overview card's sentence, e.g. "Best click rate in 6 campaigns." */
export function campaignHeadline(
	targetId: string,
	history: readonly RatedCampaign[],
	average: CampaignRates
): HeadlineMessage | null {
	const verdict = headlineVerdict(targetId, history, average);
	if (!verdict) return null;
	return { key: `components.marketing.headline.${verdict.kind}`, params: paramsOf(verdict) };
}

/**
 * The report's lead sentence, e.g. "41% opened and 6.2% clicked — the best
 * click rate in your last 6 campaigns." Without a history to compare against
 * it still states the two rates.
 */
export function reportHeadline(
	targetId: string,
	history: readonly RatedCampaign[],
	average: CampaignRates,
	rates: { open: string; click: string }
): HeadlineMessage {
	const verdict = headlineVerdict(targetId, history, average);
	const kind = verdict?.kind ?? 'none';
	return {
		key: `components.campaigns.reportHeadline.${kind}`,
		params: { ...(verdict ? paramsOf(verdict) : {}), open: rates.open, click: rates.click },
	};
}

/** The counters a delivered-weighted rate set is computed from. */
export interface EngagementCounts {
	delivered: number;
	opened: number;
	clicked: number;
	unsubscribed: number;
}

function rate(numerator: number, denominator: number): number {
	return denominator > 0 ? numerator / denominator : 0;
}

/** One campaign's rates over its delivered count (0 when nothing was delivered). */
export function ratesOf(counts: EngagementCounts): CampaignRates {
	return {
		openRate: rate(counts.opened, counts.delivered),
		clickRate: rate(counts.clicked, counts.delivered),
		unsubscribeRate: rate(counts.unsubscribed, counts.delivered),
	};
}

/** Delivered-weighted average over several campaigns' counters. */
export function averageRates(campaigns: readonly EngagementCounts[]): CampaignRates {
	const sum = { delivered: 0, opened: 0, clicked: 0, unsubscribed: 0 };
	for (const c of campaigns) {
		sum.delivered += c.delivered;
		sum.opened += c.opened;
		sum.clicked += c.clicked;
		sum.unsubscribed += c.unsubscribed;
	}
	return ratesOf(sum);
}

/** Difference to the average in percentage points, signed: "+3.1 pts" / "−0.4 pts". */
export function pointsDelta(value: number, average: number): { text: string; sign: -1 | 0 | 1 } {
	const points = Math.round((value - average) * 1000) / 10;
	if (points === 0) return { text: '0.0', sign: 0 };
	return {
		text: `${points > 0 ? '+' : '−'}${Math.abs(points).toFixed(1)}`,
		sign: points > 0 ? 1 : -1,
	};
}
