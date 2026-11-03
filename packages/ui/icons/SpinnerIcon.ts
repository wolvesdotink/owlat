import { h, type FunctionalComponent } from 'vue';
import { SpinnerIcon as CooliconsSpinner, type IconProps } from '@coolicons/vue';

/**
 * The app's loading glyph, used wherever an icon slot shows work in progress:
 * coolicons' `spinner` that turns.
 *
 * It spins by itself, and stops for someone who asked for less motion, so
 * callers add no spin or reduced-motion classes of their own. It takes the
 * coolicons props, so it drops into any place a coolicons component goes,
 * including an `IconComponent`-typed field.
 */
export const SpinnerIcon: FunctionalComponent<IconProps> = (props) =>
	h(CooliconsSpinner, { ...props, class: 'animate-spin motion-reduce:animate-none' });

SpinnerIcon.props = {
	size: { type: [Number, String], default: 24 },
	strokeWidth: { type: [Number, String], default: 2 },
	title: { type: String, default: undefined },
};
SpinnerIcon.displayName = 'SpinnerIcon';
