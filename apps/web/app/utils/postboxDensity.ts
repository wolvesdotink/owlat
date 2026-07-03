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
 * Estimated thread-row height (px) per density. Feeds `contain-intrinsic-size`
 * on the `content-visibility: auto` rows so the browser's scrollbar estimate
 * matches the actual rendered row height — a wrong value makes the scrollbar
 * jump as off-screen rows realise. Compact drops the standalone snippet line
 * and tightens the vertical padding, so its rows are materially shorter.
 */
export const POSTBOX_ROW_INTRINSIC_PX: Record<PostboxDensity, number> = {
	comfortable: 76,
	compact: 52,
};

/** The `contain-intrinsic-size` height for a given density, in px. */
export function postboxRowIntrinsicPx(density: PostboxDensity): number {
	return POSTBOX_ROW_INTRINSIC_PX[density] ?? POSTBOX_ROW_INTRINSIC_PX.comfortable;
}

/** Normalise a stored/unknown value to a valid density, defaulting safely. */
export function resolvePostboxDensity(value: string | undefined | null): PostboxDensity {
	return value === 'compact' ? 'compact' : POSTBOX_DENSITY_DEFAULT;
}
