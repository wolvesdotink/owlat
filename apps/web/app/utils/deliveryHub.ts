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

/** Health tone shared by the verdict chip and the stat tiles. */
export type DeliveryTone = 'ok' | 'warn' | 'error';

export interface DeliveryVerdict {
	label: string;
	tone: DeliveryTone;
}

const VERDICT: Record<DeliveryHealthLevel, DeliveryVerdict> = {
	ok: { label: 'Healthy', tone: 'ok' },
	warn: { label: 'At risk', tone: 'warn' },
	error: { label: 'Blocked', tone: 'error' },
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
export function warmupSentence(warming: WarmupInput | null): string | null {
	if (!warming) return null;
	if (warming.phase === 'graduated') return 'Fully warmed — sending at full volume.';
	if (warming.phase === 'plateau') return 'Warm-up paused — sending is temporarily held.';

	const day = warming.ips.length ? Math.max(...warming.ips.map((ip) => ip.currentDay)) : 0;
	const pct = Math.min(100, Math.max(0, Math.round((day / WARMUP_DAYS) * 100)));
	return `Warming up — day ${day} of ${WARMUP_DAYS} · ${pct}% of full sending volume`;
}

/** A single stat tile on the health hub, threshold copy included. */
export interface DeliveryStatTile {
	key: 'bounce' | 'complaint' | 'budget';
	label: string;
	value: string;
	/** Threshold reminder shown under the value ("limit 2%", "cap 50,000"). */
	threshold: string;
	tone: DeliveryTone;
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

/**
 * Build the three stat tiles — Bounce rate, Complaint rate, Today's send budget
 * — each carrying its threshold copy and a tone derived from the SAME shared
 * thresholds the backend classifies risk with. Pure so the threshold-copy
 * mapping ("limit 2%", "limit 0.1%") is unit-testable.
 */
export function deliveryStatTiles(
	reputation: StatReputation | null,
	budget: StatBudget | null
): DeliveryStatTile[] {
	const bounceLimit = REPUTATION_THRESHOLDS.bounce.medium;
	const complaintLimit = REPUTATION_THRESHOLDS.complaint.medium;

	const bounce: DeliveryStatTile = {
		key: 'bounce',
		label: 'Bounce rate',
		value: reputation ? formatPercentage(reputation.bounceRate, 2) : '—',
		threshold: `limit ${formatPercentage(bounceLimit, 0)}`,
		tone: reputation ? rateTone(reputation.bounceRate, REPUTATION_THRESHOLDS.bounce) : 'ok',
	};

	const complaint: DeliveryStatTile = {
		key: 'complaint',
		label: 'Complaint rate',
		value: reputation ? formatPercentage(reputation.complaintRate, 2) : '—',
		threshold: `limit ${formatPercentage(complaintLimit, 1)}`,
		tone: reputation ? rateTone(reputation.complaintRate, REPUTATION_THRESHOLDS.complaint) : 'ok',
	};

	let budgetTile: DeliveryStatTile;
	if (budget && budget.totalDailyCap > 0) {
		const usedFraction = budget.totalSentToday / budget.totalDailyCap;
		const budgetTone: DeliveryTone =
			budget.remainingToday <= 0 ? 'error' : usedFraction >= 0.9 ? 'warn' : 'ok';
		budgetTile = {
			key: 'budget',
			label: "Today's send budget",
			value: formatNumber(budget.remainingToday),
			threshold: `cap ${formatNumber(budget.totalDailyCap)}`,
			tone: budgetTone,
		};
	} else {
		budgetTile = {
			key: 'budget',
			label: "Today's send budget",
			value: '—',
			threshold: 'cap not synced yet',
			tone: 'ok',
		};
	}

	return [bounce, complaint, budgetTile];
}
