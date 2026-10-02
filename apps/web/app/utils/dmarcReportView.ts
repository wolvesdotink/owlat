/**
 * Pure view helpers for the DMARC reports surfaces: the dashboard page
 * (`pages/dashboard/admin/delivery/dmarc.vue`) and the reporting panel on each
 * sending domain (`components/domains/DmarcReportingPanel.vue`).
 *
 * Copy is passed as i18n KEYS, never sentences, so the module stays usable
 * outside a component and the rendered text always comes from the locale files.
 */

import type { HealthTone } from './healthTone';

/** The windows the dashboard offers (mirrors the backend's accepted values). */
export const DMARC_WINDOW_OPTIONS = [7, 30, 90] as const;
export type DmarcWindowDays = (typeof DMARC_WINDOW_OPTIONS)[number];

export type DmarcSourceKind = 'owlat' | 'known' | 'unknown';

/** Format a 0–1 pass rate as a percentage with one decimal under 100%, or a dash. */
export function formatPassRate(rate: number | null): string {
	if (rate === null) return '—';
	const percent = rate * 100;
	if (percent >= 100) return '100%';
	// 99.6% must not round up to "100%" on a dashboard that is about the last 1%.
	return `${(Math.floor(percent * 10) / 10).toFixed(1)}%`;
}

/**
 * Tone for a DMARC pass rate. The enforcement threshold is 99%, so that is the
 * line between healthy and warning; below 90% something real is failing.
 */
export function passRateTone(rate: number | null): HealthTone {
	if (rate === null) return 'neutral';
	if (rate >= 0.99) return 'success';
	if (rate >= 0.9) return 'warning';
	return 'error';
}

/** i18n key for a source kind's badge. */
export function sourceKindKey(kind: DmarcSourceKind): string {
	return `components.delivery.dmarcSources.kind.${kind}`;
}

/** Badge variant per source kind: ours reads as calm, unknown asks for a look. */
export function sourceKindVariant(kind: DmarcSourceKind): 'success' | 'default' | 'warning' {
	if (kind === 'owlat') return 'success';
	if (kind === 'known') return 'default';
	return 'warning';
}

/** The pass rate of one source row, or null when it sent nothing. */
export function sourcePassRate(source: { messageCount: number; alignedCount: number }) {
	return source.messageCount > 0 ? source.alignedCount / source.messageCount : null;
}

export type DmarcReadinessState =
	| 'enforced'
	| 'ready'
	| 'building'
	| 'failing'
	| 'incomplete'
	| 'no-data';

/**
 * Where a domain stands on the way to `p=reject`:
 * - `enforced` — already at reject, nothing left to raise;
 * - `ready` — enough clean days, the next step is safe to publish;
 * - `building` — clean so far, but not for long enough yet;
 * - `failing` — the most recent day with reports was below the threshold;
 * - `incomplete` — a truncated read cut the clean run short before it was
 *   long enough, so no verdict either way;
 * - `no-data` — no reports in the readiness window.
 */
export function readinessState(readiness: {
	nextPolicy: string | null;
	isReady: boolean;
	isIncomplete?: boolean;
	streakDays: number;
	latestAlignedRate: number | null;
}): DmarcReadinessState {
	if (readiness.nextPolicy === null) return 'enforced';
	if (readiness.isReady) return 'ready';
	if (readiness.isIncomplete) return 'incomplete';
	if (readiness.latestAlignedRate === null) return 'no-data';
	return readiness.streakDays > 0 ? 'building' : 'failing';
}

/** Bar heights for one day of the trend chart, as fractions of the tallest day. */
export function trendBars(
	points: ReadonlyArray<{ date: string; messageCount: number; alignedCount: number }>
): Array<{
	date: string;
	passed: number;
	failed: number;
	passedShare: number;
	failedShare: number;
}> {
	const peak = points.reduce((max, point) => Math.max(max, point.messageCount), 0);
	return points.map((point) => {
		const failed = Math.max(0, point.messageCount - point.alignedCount);
		return {
			date: point.date,
			passed: point.alignedCount,
			failed,
			passedShare: peak > 0 ? point.alignedCount / peak : 0,
			failedShare: peak > 0 ? failed / peak : 0,
		};
	});
}
