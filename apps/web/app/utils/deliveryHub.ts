import { REPUTATION_THRESHOLDS } from '@owlat/shared/reputation';
import type { DeliveryHealthLevel } from '~/composables/useDeliveryHealth';
import { formatNumber, formatPercentage } from '~/utils/formatters';

/**
 * Pure copy/derivation helpers for the Delivery health page. Kept DB- and
 * DOM-free so the verdict wording, the warm-up sentence, and — critically — the
 * threshold copy on the stat tiles are unit-testable without mounting anything.
 * The page and the sidebar dot both read the SAME `getDeliveryHealth` query, and
 * `deliveryVerdict` is the one place a level becomes human words, so the chip and
 * the dot can never disagree.
 */

/**
 * A translatable value produced by a module-scope definition set: the message
 * KEY the page resolves, plus the parameters it interpolates. These tables are
 * evaluated at import time, long before a locale is active, so they carry keys
 * rather than sentences.
 */
export type LocalizedText = string | { key: string; params?: Record<string, unknown> };

/** Health tone shared by the verdict chip and the stat tiles. */
export type DeliveryTone = 'ok' | 'warn' | 'error';

export interface DeliveryVerdict {
	label: LocalizedText;
	tone: DeliveryTone;
}

const VERDICT: Record<DeliveryHealthLevel, DeliveryVerdict> = {
	ok: { label: 'shared.deliveryHub.verdict.ok', tone: 'ok' },
	warn: { label: 'shared.deliveryHub.verdict.warn', tone: 'warn' },
	error: { label: 'shared.deliveryHub.verdict.error', tone: 'error' },
};

/** Map the roll-up level to the header chip's human label + tone. */
export function deliveryVerdict(level: DeliveryHealthLevel): DeliveryVerdict {
	return VERDICT[level];
}

/** Minimal warm-up shape the sentence needs (a subset of the sending overview). */
export interface WarmupInput {
	phase: string;
	ips: Array<{ currentDay: number }>;
}

/** Total number of days an IP takes to fully warm (MTA convention). */
const WARMUP_DAYS = 30;

/**
 * One human line describing where IP warm-up stands, or `null` when there's no
 * warming data yet (so the page omits the line rather than inventing one). No AI
 * jargon, no raw enum — plain words only.
 */
export function warmupSentence(warming: WarmupInput | null): LocalizedText | null {
	if (!warming) return null;
	if (warming.phase === 'graduated') return 'shared.deliveryHub.warmup.graduated';
	if (warming.phase === 'plateau') return 'shared.deliveryHub.warmup.plateau';

	const day = warming.ips.length ? Math.max(...warming.ips.map((ip) => ip.currentDay)) : 0;
	const pct = Math.min(100, Math.max(0, Math.round((day / WARMUP_DAYS) * 100)));
	return {
		key: 'shared.deliveryHub.warmup.warming',
		params: { day, total: WARMUP_DAYS, percent: pct },
	};
}

/** Glyph direction for a day-over-day delta. */
export type StatDeltaDirection = 'up' | 'down' | 'flat';
/** Whether a delta reads as good/bad/neutral (decoupled from the glyph). */
export type StatDeltaTone = 'positive' | 'negative' | 'neutral';

/** A single stat tile on the health hub, threshold copy included. */
export interface DeliveryStatTile {
	key: 'bounce' | 'complaint' | 'budget';
	label: LocalizedText;
	value: string;
	/** Threshold reminder shown under the value ("limit 2%", "cap 50,000"). */
	threshold: LocalizedText;
	tone: DeliveryTone;
	/** Signed day-over-day change text ("0.30%"), or `undefined` with no prior day. */
	delta?: string;
	/** Which way the value moved since the previous snapshot. */
	deltaDirection: StatDeltaDirection;
	/** Whether that movement is good/bad for this metric (bounce ↓ is good). */
	deltaTone: StatDeltaTone;
}

/** Reputation subset the tiles read. `null` = no in-window sending activity. */
export interface StatReputation {
	bounceRate: number;
	complaintRate: number;
}

/** Today's send-budget subset the tiles read. `null` = no warming data yet. */
export interface StatBudget {
	totalSentToday: number;
	totalDailyCap: number;
	remainingToday: number;
}

/** Bounce/complaint tone against the shared medium/high thresholds. */
function rateTone(rate: number, thresholds: { medium: number; high: number }): DeliveryTone {
	if (rate >= thresholds.high) return 'error';
	if (rate >= thresholds.medium) return 'warn';
	return 'ok';
}

/** No-movement default when there is no prior day to compare against. */
const NO_DELTA = {
	deltaDirection: 'flat' as StatDeltaDirection,
	deltaTone: 'neutral' as StatDeltaTone,
};

/**
 * Day-over-day delta for a "lower is better" rate (bounce/complaint): a fall is
 * `positive` (green ↓), a rise is `negative` (red ↑). Returns just the direction
 * + tone default when there's no prior day so the tile shows no delta line.
 */
function lowerIsBetterDelta(
	current: number,
	prev: number | null | undefined
): { delta?: string; deltaDirection: StatDeltaDirection; deltaTone: StatDeltaTone } {
	if (prev === null || prev === undefined) return { ...NO_DELTA };
	const diff = current - prev;
	const delta = formatPercentage(Math.abs(diff), 2);
	if (diff > 0) return { delta, deltaDirection: 'up', deltaTone: 'negative' };
	if (diff < 0) return { delta, deltaDirection: 'down', deltaTone: 'positive' };
	return { delta, deltaDirection: 'flat', deltaTone: 'neutral' };
}

/**
 * Build the three stat tiles — Bounce rate, Complaint rate, Today's send budget
 * — each carrying its threshold copy and a tone derived from the SAME shared
 * thresholds the backend classifies risk with. Pure so the threshold-copy
 * mapping ("limit 2%", "limit 0.1%") is unit-testable.
 */
export function deliveryStatTiles(
	reputation: StatReputation | null,
	budget: StatBudget | null,
	previous?: StatReputation | null
): DeliveryStatTile[] {
	const bounceLimit = REPUTATION_THRESHOLDS.bounce.medium;
	const complaintLimit = REPUTATION_THRESHOLDS.complaint.medium;

	const bounce: DeliveryStatTile = {
		key: 'bounce',
		label: 'shared.deliveryHub.tiles.bounce.label',
		value: reputation ? formatPercentage(reputation.bounceRate, 2) : '—',
		threshold: {
			key: 'shared.deliveryHub.tiles.limit',
			params: { limit: formatPercentage(bounceLimit, 0) },
		},
		tone: reputation ? rateTone(reputation.bounceRate, REPUTATION_THRESHOLDS.bounce) : 'ok',
		...(reputation
			? lowerIsBetterDelta(reputation.bounceRate, previous?.bounceRate ?? null)
			: NO_DELTA),
	};

	const complaint: DeliveryStatTile = {
		key: 'complaint',
		label: 'shared.deliveryHub.tiles.complaint.label',
		value: reputation ? formatPercentage(reputation.complaintRate, 2) : '—',
		threshold: {
			key: 'shared.deliveryHub.tiles.limit',
			params: { limit: formatPercentage(complaintLimit, 1) },
		},
		tone: reputation ? rateTone(reputation.complaintRate, REPUTATION_THRESHOLDS.complaint) : 'ok',
		...(reputation
			? lowerIsBetterDelta(reputation.complaintRate, previous?.complaintRate ?? null)
			: NO_DELTA),
	};

	let budgetTile: DeliveryStatTile;
	if (budget && budget.totalDailyCap > 0) {
		const usedFraction = budget.totalSentToday / budget.totalDailyCap;
		const budgetTone: DeliveryTone =
			budget.remainingToday <= 0 ? 'error' : usedFraction >= 0.9 ? 'warn' : 'ok';
		budgetTile = {
			key: 'budget',
			label: 'shared.deliveryHub.tiles.budget.label',
			value: formatNumber(budget.remainingToday),
			threshold: {
				key: 'shared.deliveryHub.tiles.cap',
				params: { cap: formatNumber(budget.totalDailyCap) },
			},
			tone: budgetTone,
			// Today's budget is a live counter, not a persisted daily snapshot, so
			// there's no meaningful day-over-day delta to draw.
			...NO_DELTA,
		};
	} else {
		budgetTile = {
			key: 'budget',
			label: 'shared.deliveryHub.tiles.budget.label',
			value: '—',
			threshold: 'shared.deliveryHub.tiles.capUnsynced',
			tone: 'ok',
			...NO_DELTA,
		};
	}

	return [bounce, complaint, budgetTile];
}
