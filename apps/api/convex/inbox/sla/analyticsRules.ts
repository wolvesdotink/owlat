/**
 * Team Inbox response analytics: the numbers the analytics page shows,
 * computed from the conversations that STARTED in the chosen range.
 *
 *   - volume: new conversations per UTC day;
 *   - first response time: `firstResponseAt - firstMessageAt`, wall-clock,
 *     because that is what the customer waited;
 *   - resolution time: `resolvedAt - firstMessageAt`, for conversations
 *     resolved or closed now;
 *   - target hit rate: replies on time over replies judged, with a deadline
 *     that has already passed unanswered counted as a miss;
 *   - the same per current assignee.
 *
 * Medians and the 90th percentile use the nearest-rank method, so every value
 * shown is one that actually happened. Pure.
 */

import type { Doc } from '../../_generated/dataModel';
import { utcDayKey } from '../../lib/clock';

const DAY_MS = 24 * 60 * 60 * 1000;

export type AnalyticsThread = Pick<
	Doc<'conversationThreads'>,
	| 'firstMessageAt'
	| 'firstResponseAt'
	| 'resolvedAt'
	| 'status'
	| 'assignedTo'
	| 'slaMetCount'
	| 'slaMissedCount'
	| 'responseDueAt'
>;

export interface Spread {
	median: number;
	p90: number;
	count: number;
}

export interface TargetTally {
	met: number;
	missed: number;
	/** Running deadlines already passed: counted in `missed` too. */
	overdueNow: number;
	/** `met / (met + missed)`, or null when nothing was judged. */
	hitRate: number | null;
}

export interface AssigneeRow extends TargetTally {
	/** BetterAuth user id, or null for unassigned conversations. */
	userId: string | null;
	conversations: number;
	firstResponse: Spread | null;
}

export interface ResponseAnalytics {
	conversations: number;
	firstResponse: Spread | null;
	resolution: Spread | null;
	targets: TargetTally;
	daily: { date: string; conversations: number; medianFirstResponseMs: number | null }[];
	assignees: AssigneeRow[];
}

/** Nearest-rank percentile of an ascending list; `p` in (0, 1]. */
export function nearestRank(sorted: readonly number[], p: number): number {
	const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
	return sorted[index]!;
}

export function spreadOf(values: readonly number[]): Spread | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	return { median: nearestRank(sorted, 0.5), p90: nearestRank(sorted, 0.9), count: sorted.length };
}

function firstResponseMs(thread: AnalyticsThread): number | null {
	if (thread.firstResponseAt === undefined) return null;
	return Math.max(0, thread.firstResponseAt - thread.firstMessageAt);
}

function resolutionMs(thread: AnalyticsThread): number | null {
	if (thread.resolvedAt === undefined) return null;
	if (thread.status !== 'resolved' && thread.status !== 'closed') return null;
	return Math.max(0, thread.resolvedAt - thread.firstMessageAt);
}

function tally(threads: readonly AnalyticsThread[], now: number): TargetTally {
	let met = 0;
	let missed = 0;
	let overdueNow = 0;
	for (const thread of threads) {
		met += thread.slaMetCount ?? 0;
		missed += thread.slaMissedCount ?? 0;
		if (thread.responseDueAt !== undefined && thread.responseDueAt <= now) overdueNow++;
	}
	const judged = met + missed + overdueNow;
	return {
		met,
		missed: missed + overdueNow,
		overdueNow,
		hitRate: judged === 0 ? null : met / judged,
	};
}

/**
 * Summarize the conversations that started in `[fromMs, toMs)`; rows outside
 * the range are ignored. `fromMs` is a UTC day start; the daily series covers
 * every day of the range, quiet days as zero.
 */
export function summarizeResponseAnalytics(
	threads: readonly AnalyticsThread[],
	range: { fromMs: number; toMs: number; now: number }
): ResponseAnalytics {
	const inRange = threads.filter(
		(t) => t.firstMessageAt >= range.fromMs && t.firstMessageAt < range.toMs
	);

	const byDay = new Map<string, AnalyticsThread[]>();
	const byAssignee = new Map<string | null, AnalyticsThread[]>();
	const push = <K>(map: Map<K, AnalyticsThread[]>, key: K, thread: AnalyticsThread) => {
		const rows = map.get(key);
		if (rows) rows.push(thread);
		else map.set(key, [thread]);
	};
	for (const thread of inRange) {
		push(byDay, utcDayKey(thread.firstMessageAt), thread);
		push(byAssignee, thread.assignedTo ?? null, thread);
	}

	const firstResponses = (rows: readonly AnalyticsThread[]) =>
		rows.map(firstResponseMs).filter((ms): ms is number => ms !== null);

	const daily: ResponseAnalytics['daily'] = [];
	for (let at = range.fromMs; at < range.toMs; at += DAY_MS) {
		const date = utcDayKey(at);
		const rows = byDay.get(date) ?? [];
		daily.push({
			date,
			conversations: rows.length,
			medianFirstResponseMs: spreadOf(firstResponses(rows))?.median ?? null,
		});
	}

	const assignees: AssigneeRow[] = [...byAssignee.entries()]
		.map(([userId, rows]) => ({
			userId,
			conversations: rows.length,
			firstResponse: spreadOf(firstResponses(rows)),
			...tally(rows, range.now),
		}))
		.sort((a, b) => b.conversations - a.conversations);

	return {
		conversations: inRange.length,
		firstResponse: spreadOf(firstResponses(inRange)),
		resolution: spreadOf(inRange.map(resolutionMs).filter((ms): ms is number => ms !== null)),
		targets: tally(inRange, range.now),
		daily,
		assignees,
	};
}
