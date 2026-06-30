/**
 * Score band thresholds + mappings shared across the previewer's analysis UI.
 *
 * A score is a 0–100 number. Colours use three bands (excellent / fair / poor);
 * labels use four. Callers handle their own null/"no data" fallbacks since those
 * differ by surface (e.g. a tertiary colour vs an "N/A" label).
 */

/** CSS variable name for the colour at a given score. */
export function scoreColor(value: number): string {
	if (value >= 90) return 'var(--ep-success)';
	if (value >= 70) return 'var(--ep-warning)';
	return 'var(--ep-error)';
}

/** Human-readable quality label for a given score. */
export function scoreLabel(value: number): string {
	if (value >= 90) return 'Excellent';
	if (value >= 70) return 'Good';
	if (value >= 50) return 'Fair';
	return 'Poor';
}
