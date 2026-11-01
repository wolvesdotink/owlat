import { h, type FunctionalComponent } from 'vue';
import type { IconProps } from '@coolicons/vue';

/**
 * The app's loading glyph, used wherever an icon slot shows work in progress.
 *
 * coolicons has no spinner (its `loading` is a row of dots that reads as
 * "more", not "busy"), so this one is drawn on the coolicons grid instead: a
 * 24px box, a circle inside the same 3–21 bounds the set's round glyphs use,
 * the same 2px round stroke, a faint track and a quarter arc. It takes the
 * coolicons props, so it drops into any place a coolicons component goes,
 * including an `IconComponent`-typed field.
 *
 * It spins by itself, and stops for someone who asked for less motion, so
 * callers add no spin or reduced-motion classes of their own.
 */
export const SpinnerIcon: FunctionalComponent<IconProps> = (props) => {
	const size = props.size ?? 24;
	const strokeWidth = props.strokeWidth ?? 2;
	const labelled = props.title != null && props.title !== '';
	return h(
		'svg',
		{
			width: size,
			height: size,
			viewBox: '0 0 24 24',
			fill: 'none',
			xmlns: 'http://www.w3.org/2000/svg',
			class: 'animate-spin motion-reduce:animate-none',
			role: labelled ? 'img' : undefined,
			'aria-hidden': labelled ? undefined : 'true',
		},
		[
			labelled ? h('title', props.title) : null,
			h('circle', {
				cx: 12,
				cy: 12,
				r: 9,
				stroke: 'currentColor',
				'stroke-opacity': 0.25,
				'stroke-width': strokeWidth,
			}),
			h('path', {
				d: 'M21 12A9 9 0 0 0 12 3',
				stroke: 'currentColor',
				'stroke-width': strokeWidth,
				'stroke-linecap': 'round',
			}),
		]
	);
};

SpinnerIcon.props = {
	size: { type: [Number, String], default: 24 },
	strokeWidth: { type: [Number, String], default: 2 },
	title: { type: String, default: undefined },
};
SpinnerIcon.displayName = 'SpinnerIcon';
