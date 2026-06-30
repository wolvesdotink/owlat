import type { GradientBackground } from '../types';
import { gradientToCssOrUndefined } from '@owlat/shared';

/**
 * Build a CSS `linear-gradient(...)` string from a block's gradient background.
 *
 * Thin wrapper over the shared gradient rule so the editor preview matches the
 * renderer. Returns `undefined` when the gradient is absent or has fewer than
 * `minStops` stops; the Hero block passes `minStops: 1` to keep its historical
 * single-stop (flat fill) behaviour.
 */
export function gradientCss(g: GradientBackground | undefined, minStops = 2): string | undefined {
	return gradientToCssOrUndefined(g, minStops);
}
