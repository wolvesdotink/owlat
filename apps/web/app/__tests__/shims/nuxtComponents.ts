/**
 * Test-time stand-in for Nuxt's `#components` virtual module.
 *
 * Components that render a link through `<component :is>` must import
 * `NuxtLink` explicitly (the template-time `resolveComponent('NuxtLink')`
 * shortcut is not resolvable in a Nuxt app and renders a bare `<nuxtlink>`
 * element with no href — the private-inbox row click was dead for exactly that
 * reason). Vitest has no Nuxt build, so this shim provides the one export those
 * components need: an anchor that carries `to` as its href, matching the stub
 * the component tests already register by name.
 */
import { defineComponent, h } from 'vue';

export const NuxtLink = defineComponent({
	name: 'NuxtLink',
	props: { to: { type: [String, Object], default: undefined } },
	setup(props, { slots, attrs }) {
		return () =>
			h('a', { ...attrs, href: typeof props.to === 'string' ? props.to : undefined }, slots.default?.());
	},
});
