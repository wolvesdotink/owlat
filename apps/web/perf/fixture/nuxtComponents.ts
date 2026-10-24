/**
 * The fixture's `#components` (Nuxt's virtual component module) and its
 * global `NuxtLink`.
 *
 * Nuxt renders a `NuxtLink` to an internal route as one `<a href>` around its
 * slot; so does this stand-in. What it leaves out is the router's click
 * handling and Nuxt's prefetch of links as they scroll into view, neither of
 * which runs in a fixture with no router.
 */
import { defineComponent, h } from 'vue';

export const NuxtLink = defineComponent({
	name: 'NuxtLink',
	inheritAttrs: false,
	props: { to: { type: [String, Object], default: undefined } },
	setup(props, { slots, attrs }) {
		return () =>
			h(
				'a',
				{ ...attrs, href: typeof props.to === 'string' ? props.to : undefined },
				slots['default']?.()
			);
	},
});
