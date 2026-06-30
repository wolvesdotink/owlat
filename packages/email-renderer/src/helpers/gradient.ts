import type { GradientBackground } from '@owlat/shared';
import { gradientToCss, gradientToCssOrUndefined } from '@owlat/shared';

// The gradient→CSS rule lives in @owlat/shared so the renderer and the editor
// preview agree. Re-exported so existing renderer call sites keep importing it
// from here.
export { gradientToCss };

/**
 * Emit a ready-to-concat `background:<gradient>;` CSS declaration, or `''` when
 * the gradient is absent or has fewer than two stops (a single-stop gradient
 * isn't a gradient). Used by blocks that build an inline `style` string by
 * concatenating declarations (hero, container). Blocks that push individual
 * declarations into a `;`-joined array use `gradientToCss` directly instead, to
 * avoid a doubled separator.
 */
export const gradientToCssOrEmpty = (gradient: GradientBackground | undefined): string => {
	const css = gradientToCssOrUndefined(gradient, 2);
	return css ? `background:${css};` : '';
};
