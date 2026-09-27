/**
 * Pure math behind the Marketing overview (`analytics/marketingOverview.ts`).
 *
 * No Convex, no DB: the query reads campaign rows and hands their denormalized
 * `stats*` counters here, so rates, averages and weekly buckets are unit-tested
 * directly (`analytics/__tests__/marketingOverviewMath.test.ts`).
 *
 * Every rate is a FRACTION (0–1), not a percentage. Engagement rates (open,
 * click, unsubscribe) are over delivered; the bounce rate is over sent, because
 * a bounced message is by definition not in the delivered count.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** The denormalized counters one campaign contributes. */
export interface CampaignCounts {
	sent: number;
	delivered: number;
	opened: number;
	clicked: number;
	unsubscribed: number;
	bounced: number;
}

/** A campaign's counters plus the instant it went out. */
export interface DatedCampaignCounts extends CampaignCounts {
	sentAt: number;
}

export interface EngagementRates {
	openRate: number;
	clickRate: number;
	unsubscribeRate: number;
}

export interface PeriodTotals extends EngagementRates {
	delivered: number;
	bounceRate: number;
}

/** `numerator / denominator`, or 0 when there is nothing to divide by. */
export function safeRate(numerator: number, denominator: number): number {
	return denominator > 0 ? numerator / denominator : 0;
}

/** Open / click / unsubscribe rate of one campaign, over its delivered count. */
export function engagementRates(counts: CampaignCounts): EngagementRates {
	return {
		openRate: safeRate(counts.opened, counts.delivered),
		clickRate: safeRate(counts.clicked, counts.delivered),
		unsubscribeRate: safeRate(counts.unsubscribed, counts.delivered),
	};
}

function sumCounts(campaigns: readonly CampaignCounts[]): CampaignCounts {
	const total: CampaignCounts = {
		sent: 0,
		delivered: 0,
		opened: 0,
		clicked: 0,
		unsubscribed: 0,
		bounced: 0,
	};
	for (const c of campaigns) {
		total.sent += c.sent;
		total.delivered += c.delivered;
		total.opened += c.opened;
		total.clicked += c.clicked;
		total.unsubscribed += c.unsubscribed;
		total.bounced += c.bounced;
	}
	return total;
}

/**
 * Delivered-weighted average engagement over a set of campaigns: the summed
 * counters divided once, so a 50-recipient test send cannot swing the average
 * as much as a 20,000-recipient newsletter.
 */
export function weightedAverageRates(campaigns: readonly CampaignCounts[]): EngagementRates {
	return engagementRates(sumCounts(campaigns));
}

/** Totals and rates for every campaign in a period. */
export function periodTotals(campaigns: readonly CampaignCounts[]): PeriodTotals {
	const total = sumCounts(campaigns);
	return {
		delivered: total.delivered,
		...engagementRates(total),
		bounceRate: safeRate(total.bounced, total.sent),
	};
}

/**
 * What one campaign says about the automated opens or clicks (Apple MPP,
 * security scanners) kept out of its reader counts.
 */
export interface AutomatedCounts {
	/** Sends with at least one automated open (or click). */
	automated: number;
	/** False for campaigns counted before automated ones were filtered. */
	isFiltered: boolean;
}

export interface AutomatedSummary {
	/**
	 * Sends with automated opens (or clicks), summed over the campaigns. A send
	 * can also have a reader open or click, so this is not what the rate lost.
	 */
	excluded: number;
	/** Whether any campaign was counted before the filter existed. */
	includesUnfiltered: boolean;
}

/**
 * The note beside an open or click rate: how many sends had automated
 * traffic, and whether some of its campaigns predate the filter and may still
 * carry it.
 */
export function automatedSummary(campaigns: readonly AutomatedCounts[]): AutomatedSummary {
	let excluded = 0;
	let includesUnfiltered = false;
	for (const c of campaigns) {
		excluded += c.automated;
		if (!c.isFiltered) includesUnfiltered = true;
	}
	return { excluded, includesUnfiltered };
}

/**
 * Campaigns whose `sentAt` falls in `[from, to)`. Half-open so a campaign on a
 * boundary is counted in exactly one window.
 */
export function inWindow<T extends { sentAt: number }>(
	campaigns: readonly T[],
	from: number,
	to: number
): T[] {
	return campaigns.filter((c) => c.sentAt >= from && c.sentAt < to);
}

/**
 * `weeks` consecutive 7-day buckets ending at `now`, oldest first. Bucket `i`
 * covers `[now - (weeks - i) × 7d, now - (weeks - i - 1) × 7d)`, so the last
 * bucket is the trailing week and ends just before `now` itself.
 */
export function weeklyTotals(
	campaigns: readonly DatedCampaignCounts[],
	now: number,
	weeks: number
): PeriodTotals[] {
	const buckets: PeriodTotals[] = [];
	for (let i = 0; i < weeks; i++) {
		const from = now - (weeks - i) * WEEK_MS;
		buckets.push(periodTotals(inWindow(campaigns, from, from + WEEK_MS)));
	}
	return buckets;
}

/** UTC `YYYY-MM-DD` — the same bucket key `sendDailyStats` rows are written under. */
export function utcDateKey(at: number): string {
	const d = new Date(at);
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(d.getUTCDate()).padStart(2, '0');
	return `${yyyy}-${mm}-${dd}`;
}

/**
 * A dense `days`-long daily series ending today (UTC), oldest first. The daily
 * roll-up only has rows for days something happened; a chart needs the quiet
 * days as explicit zeros or it silently compresses the time axis.
 */
export function denseDailyOpens(
	rows: readonly { date: string; opened: number }[],
	days: number,
	now: number
): { date: string; opened: number }[] {
	const byDate = new Map(rows.map((r) => [r.date, r.opened]));
	const series: { date: string; opened: number }[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const date = utcDateKey(now - i * DAY_MS);
		series.push({ date, opened: byDate.get(date) ?? 0 });
	}
	return series;
}

/** The send walk fields a progress fraction can be derived from. */
export interface SendWalkProgress {
	phase: 'resolving' | 'done';
	enqueuedCount: number;
	plannedTotal?: number;
	isPlannedTotalLowerBound?: boolean;
}

/**
 * How far a `sending` campaign has got, 0–1, or `undefined` when the
 * denominator is unknown. Once the walk is `done` every recipient is enqueued,
 * so `enqueuedCount` is the exact total; before that only an exact (not
 * lower-bound) planned total is honest. A floor would overstate progress.
 */
export function sendingProgress(sent: number, walk: SendWalkProgress | null): number | undefined {
	if (!walk) return undefined;
	let total: number | undefined;
	if (walk.phase === 'done') total = walk.enqueuedCount;
	else if (walk.plannedTotal !== undefined && walk.isPlannedTotalLowerBound !== true) {
		total = walk.plannedTotal;
	}
	if (total === undefined || total <= 0) return undefined;
	return Math.min(1, Math.max(0, sent / total));
}
