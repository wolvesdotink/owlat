/**
 * The campaign report's send-time comparison: did the contacts sent at their
 * own best hour open and click more than the comparison group sent at the
 * start time? Reads the per-arm counters the send lifecycle keeps on the
 * campaign (`statsSendTime{Optimized,Holdout}{Delivered,Opened,Clicked}`).
 *
 * A difference is only called when a two-proportion z-test puts it outside
 * chance at the 95% level, and only once both groups have enough delivered
 * mail; anything less reads as "no clear difference", never as a win.
 *
 * Equal exposure: the holdout goes out at the start and the optimized sends
 * up to a whole window later, so comparing while sends are still landing
 * favours the holdout. The arm counters only take an open or click within
 * `SEND_TIME_ATTRIBUTION_MS` of the send going out (the backend's
 * `delivery/sendLifecycle/sendTimeEffects.ts`), and the comparison waits
 * until that much time has passed after the last send.
 */

export interface SendTimeArmCounts {
	delivered: number;
	opened: number;
	clicked: number;
}

export type SendTimeMetricVerdict = 'higher' | 'lower' | 'no_difference';

export interface SendTimeMetricComparison {
	key: 'openRate' | 'clickRate';
	optimizedRate: number;
	holdoutRate: number;
	/** Optimized minus holdout, in percentage points. */
	pointsChange: number;
	verdict: SendTimeMetricVerdict;
}

export type SendTimeComparison =
	| { state: 'no_holdout'; optimized: SendTimeArmCounts }
	| {
			state: 'measuring';
			optimized: SendTimeArmCounts;
			holdout: SendTimeArmCounts;
			/** When the comparison is due, or null while the campaign is still sending. */
			readyAt: number | null;
	  }
	| { state: 'too_early'; optimized: SendTimeArmCounts; holdout: SendTimeArmCounts }
	| {
			state: 'ready';
			optimized: SendTimeArmCounts;
			holdout: SendTimeArmCounts;
			metrics: SendTimeMetricComparison[];
	  };

/** Delivered emails each group needs before a comparison is shown. */
export const MIN_DELIVERED_PER_GROUP = 100;

/**
 * How long after a send goes out its first open or click counts for its group.
 * Mirrors `SEND_TIME_ATTRIBUTION_MS` in the backend.
 */
export const SEND_TIME_ATTRIBUTION_MS = 24 * 3_600_000;

/** |z| at or above this is a difference at the 95% level (two-sided). */
const Z_95 = 1.96;

function rate(part: number, whole: number): number {
	return whole > 0 ? part / whole : 0;
}

/** Two-proportion z statistic; 0 when it is undefined (no variance). */
export function twoProportionZ(x1: number, n1: number, x2: number, n2: number): number {
	if (n1 <= 0 || n2 <= 0) return 0;
	const pooled = (x1 + x2) / (n1 + n2);
	const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
	if (!(se > 0)) return 0;
	return (x1 / n1 - x2 / n2) / se;
}

function compareMetric(
	key: SendTimeMetricComparison['key'],
	optimized: number,
	holdout: number,
	arms: { optimized: SendTimeArmCounts; holdout: SendTimeArmCounts }
): SendTimeMetricComparison {
	const optimizedRate = rate(optimized, arms.optimized.delivered);
	const holdoutRate = rate(holdout, arms.holdout.delivered);
	const z = twoProportionZ(optimized, arms.optimized.delivered, holdout, arms.holdout.delivered);
	return {
		key,
		optimizedRate,
		holdoutRate,
		pointsChange: (optimizedRate - holdoutRate) * 100,
		verdict: z >= Z_95 ? 'higher' : z <= -Z_95 ? 'lower' : 'no_difference',
	};
}

const count = (value: number | undefined) =>
	typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;

interface SendTimeReportCampaign {
	status: string;
	sentAt?: number;
	updatedAt?: number;
	sendTimeOptimization?: { windowHours: number; holdoutPercent: number };
}

/**
 * When every send has had the full attribution window: a day after the later
 * of the window's end and the campaign's completion (its `updatedAt` once it
 * is `sent`; a later edit only moves this later). Null while still sending.
 */
export function sendTimeComparisonReadyAt(campaign: SendTimeReportCampaign): number | null {
	if (campaign.status !== 'sent' || campaign.sentAt === undefined) return null;
	const windowEnd = campaign.sentAt + (campaign.sendTimeOptimization?.windowHours ?? 0) * 3_600_000;
	return Math.max(windowEnd, campaign.updatedAt ?? windowEnd) + SEND_TIME_ATTRIBUTION_MS;
}

/** The comparison for a campaign's stored counters at `now`. */
export function compareSendTimeArms(
	campaign: SendTimeReportCampaign & {
		statsSendTimeOptimizedDelivered?: number;
		statsSendTimeOptimizedOpened?: number;
		statsSendTimeOptimizedClicked?: number;
		statsSendTimeHoldoutDelivered?: number;
		statsSendTimeHoldoutOpened?: number;
		statsSendTimeHoldoutClicked?: number;
	},
	now: number
): SendTimeComparison {
	const optimized = {
		delivered: count(campaign.statsSendTimeOptimizedDelivered),
		opened: count(campaign.statsSendTimeOptimizedOpened),
		clicked: count(campaign.statsSendTimeOptimizedClicked),
	};
	const holdout = {
		delivered: count(campaign.statsSendTimeHoldoutDelivered),
		opened: count(campaign.statsSendTimeHoldoutOpened),
		clicked: count(campaign.statsSendTimeHoldoutClicked),
	};
	if ((campaign.sendTimeOptimization?.holdoutPercent ?? 0) === 0 && holdout.delivered === 0) {
		return { state: 'no_holdout', optimized };
	}
	const readyAt = sendTimeComparisonReadyAt(campaign);
	if (readyAt === null || now < readyAt) {
		return { state: 'measuring', optimized, holdout, readyAt };
	}
	if (
		optimized.delivered < MIN_DELIVERED_PER_GROUP ||
		holdout.delivered < MIN_DELIVERED_PER_GROUP
	) {
		return { state: 'too_early', optimized, holdout };
	}
	const arms = { optimized, holdout };
	return {
		state: 'ready',
		optimized,
		holdout,
		metrics: [
			compareMetric('openRate', optimized.opened, holdout.opened, arms),
			compareMetric('clickRate', optimized.clicked, holdout.clicked, arms),
		],
	};
}
