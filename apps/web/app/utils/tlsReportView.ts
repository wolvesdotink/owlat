/**
 * Pure view-model helpers for the Delivery TLS-RPT (RFC 8460) dashboard card.
 *
 * Kept separate from the component so the rate/tone/copy derivation is unit
 * tested directly. The plain-language failure-type wording is the single source
 * in `@owlat/shared` (`explainTlsFailureType`) so the dashboard and any backend
 * consumer agree.
 */

import { explainTlsFailureType } from '@owlat/shared';
import type { HealthTone } from './healthTone';

/** Partner roll-up shape returned by `domains.tlsReports.getTlsReportSummary`. */
export interface TlsPartnerRow {
	domain: string;
	successCount: number;
	failureCount: number;
	successRate: number | null;
	reportCount: number;
}

/** Full summary shape returned by `domains.tlsReports.getTlsReportSummary`. */
export interface TlsReportSummary {
	windowDays: number;
	reportCount: number;
	totalSuccessCount: number;
	totalFailureCount: number;
	overallSuccessRate: number | null;
	partners: TlsPartnerRow[];
	failureTypeCounts: Array<{ type: string; count: number }>;
	trend: Array<{ date: string; successCount: number; failureCount: number }>;
}

/** Format a 0–1 success rate as a whole-percent string, or a dash when unknown. */
export function formatSuccessRate(rate: number | null): string {
	if (rate === null) return '—';
	return `${Math.round(rate * 100)}%`;
}

/**
 * Traffic-light tone for a TLS success rate. A single failed session is rare and
 * worth noticing, so the thresholds are deliberately strict: 99% or above is
 * healthy, 95%–99% warns, below 95% is an error. Unknown (no sessions) is
 * neutral.
 */
export function successRateTone(rate: number | null): HealthTone {
	if (rate === null) return 'neutral';
	if (rate >= 0.99) return 'success';
	if (rate >= 0.95) return 'warning';
	return 'error';
}

/** A failure-type breakdown row with plain-language copy for the UI. */
export interface TlsFailureRow {
	type: string;
	label: string;
	count: number;
}

/** Map raw `{ type, count }` tallies to display rows, most-frequent first. */
export function toFailureRows(
	counts: ReadonlyArray<{ type: string; count: number }>
): TlsFailureRow[] {
	return counts
		.map((c) => ({ type: c.type, label: explainTlsFailureType(c.type), count: c.count }))
		.sort((a, b) => b.count - a.count);
}
