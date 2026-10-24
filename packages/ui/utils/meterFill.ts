/**
 * Inline style for a `.ui-meter-fill` element (packages/ui motion.css): the
 * custom property the fill's `transform` reads, clamped to 0–100.
 *
 * A non-finite value (a ratio over an empty total) draws an empty fill. With an
 * animated `width`, `NaN%` was an invalid declaration that fell back to `auto`,
 * which painted a FULL bar for "nothing to measure".
 */
export function meterFillStyle(percent: number): Record<string, string> {
	const value = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
	return { '--ui-meter-value': String(value) };
}
