/**
 * The components Nuxt registers for every page, so a mounted tree can reach
 * them: `Icon` (@nuxt/icon), `NuxtLink`, and the UI layer's `UiButton`.
 *
 * `UiButton` is the REAL component. A stub that dropped `variant`, `size` and
 * the icon slots would let a regression in the one control every screen uses
 * pass every suite that clicks it. Its template resolves `Icon` and `NuxtLink`
 * up front, which is why those two are registered alongside it.
 */
import { config } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import UiButton from '../../../../packages/ui/components/ui/Button.vue';

export const IconStub = defineComponent({
	name: 'Icon',
	props: { name: { type: String, default: '' } },
	// Matches the real @nuxt/icon output: a decorative glyph with no accessible
	// name, so an icon-only control still fails `button-name` in an audit.
	setup: () => () => h('span', { 'aria-hidden': 'true' }),
});

export const NuxtLinkStub = defineComponent({
	name: 'NuxtLink',
	inheritAttrs: false,
	props: { to: { type: [String, Object], default: undefined } },
	setup(props, { attrs, slots }) {
		const href =
			typeof props.to === 'string' ? props.to : ((props.to as { path?: string })?.path ?? '#');
		return () => h('a', { ...attrs, href }, slots.default?.());
	},
});

/** Installed once by the vitest setup file; a suite's own `stubs` still win. */
export function registerNuxtComponents(): void {
	Object.assign(config.global.components, { Icon: IconStub, NuxtLink: NuxtLinkStub, UiButton });
}
