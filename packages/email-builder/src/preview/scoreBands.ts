/**
 * Score band thresholds + mappings shared across the previewer's analysis UI.
 *
 * A score is a 0–100 number. Colours use three bands (excellent / fair / poor);
 * labels use four bands. Callers handle their own null/"no data" fallbacks since those
 * differ by surface (e.g. a tertiary colour vs an "N/A" label).
 */

/** CSS variable name for the colour at a given score. */
export function scoreColor(value: number): string {
	if (value >= 90) return 'var(--ep-success)';
	if (value >= 70) return 'var(--ep-warning)';
	return 'var(--ep-error)';
}

/** Quality band for a given score; the label is `builder.analysis.health.band.<band>`. */
export function scoreBand(value: number): 'excellent' | 'good' | 'fair' | 'poor' {
	if (value >= 90) return 'excellent';
	if (value >= 70) return 'good';
	if (value >= 50) return 'fair';
	return 'poor';
}
