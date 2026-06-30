import { REPUTATION_THRESHOLDS } from '@owlat/shared/reputation';

/**
 * Per-metric deliverability thresholds, re-exported from the cross-tier single
 * source of truth (`@owlat/shared/reputation`) so the UI's colour boundaries
 * match the backend's risk classification. Pass these to `rateColor`.
 */
export const BOUNCE_RATE_THRESHOLDS = REPUTATION_THRESHOLDS.bounce;
export const COMPLAINT_RATE_THRESHOLDS = REPUTATION_THRESHOLDS.complaint;

/**
 * Tailwind text-color class for a deliverability rate (bounce/complaint) given
 * its per-metric warning/error thresholds. Shared by the reputation cards.
 */
export function rateColor(rate: number, thresholds: { medium: number; high: number }): string {
	if (rate >= thresholds.high) return 'text-error';
	if (rate >= thresholds.medium) return 'text-warning';
	return 'text-success';
}
