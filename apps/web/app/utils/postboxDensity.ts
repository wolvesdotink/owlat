/**
 * Postbox thread-list density: 'comfortable' (today's roomy layout) vs
 * 'compact' (tighter row padding + a single-line subject/snippet, Apple-Mail
 * style). The mode is applied as a single `data-density` attribute on the
 * Postbox root and every visual difference is expressed in CSS keyed off that
 * attribute — components never branch on density themselves.
 *
 * Pure derivation so the intrinsic-size math stays unit-testable without
 * mounting the Convex-backed layout.
 */

export type PostboxDensity = 'comfortable' | 'compact';

export const POSTBOX_DENSITY_DEFAULT: PostboxDensity = 'comfortable';

export const POSTBOX_DENSITY_OPTIONS: Array<{
	value: PostboxDensity;
	label: string;
}> = [
	{ value: 'comfortable', label: 'Comfortable' },
	{ value: 'compact', label: 'Compact' },
];

/**
 * The per-density thread-row height feeds `contain-intrinsic-size` on the
 * `content-visibility: auto` rows so the browser's scrollbar estimate matches
 * the actual rendered row height (a wrong value makes the scrollbar jump as
 * off-screen rows realise). It is a static CSS token (`--pbx-row-intrinsic`:
 * 76px comfortable / 52px compact) in postbox-density.css rather than a TS
 * constant, so there is no JS mirror to drift.
 */

/** Normalise a stored/unknown value to a valid density, defaulting safely. */
export function resolvePostboxDensity(value: string | undefined | null): PostboxDensity {
	return value === 'compact' ? 'compact' : POSTBOX_DENSITY_DEFAULT;
}
