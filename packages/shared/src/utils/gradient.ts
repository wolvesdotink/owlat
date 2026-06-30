import type { GradientBackground } from '../types/blocks';

/**
 * The single source of truth for turning a {@link GradientBackground} into a CSS
 * `linear-gradient()` value, shared by both halves of the gradient-capable Block
 * modules (button / container / hero): the renderer (table HTML) and the editor
 * (canvas preview). The two used to carry separate copies that had drifted — one
 * sorted the stops by position, the other didn't — so the editor preview could
 * disagree with the rendered email.
 *
 * Stops are sorted by position so an out-of-order definition renders the same
 * everywhere.
 */
export const gradientToCss = (gradient: GradientBackground): string => {
	const stops = gradient.stops
		.slice()
		.sort((a, b) => a.position - b.position)
		.map((s) => `${s.color} ${s.position}%`)
		.join(', ');
	return `linear-gradient(${gradient.direction || 'to bottom'}, ${stops})`;
};

/**
 * `gradientToCss`, guarded: returns `undefined` when the gradient is absent or
 * has fewer than `minStops` stops. A true gradient needs at least two stops;
 * the Hero block historically accepted a single stop (a flat fill), so callers
 * that must preserve that pass `minStops: 1`.
 */
export const gradientToCssOrUndefined = (
	gradient: GradientBackground | undefined,
	minStops = 2,
): string | undefined =>
	gradient && gradient.stops.length >= minStops ? gradientToCss(gradient) : undefined;
