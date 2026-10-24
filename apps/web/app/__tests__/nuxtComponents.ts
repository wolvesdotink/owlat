/**
 * The components Nuxt registers for every page, so a mounted tree can reach
 * them: `Icon` (@nuxt/icon), `NuxtLink`, the UI layer's `UiButton` and
 * `UiCheckbox`, and the read-state boundary `UiQueryBoundary` with the three
 * it renders.
 *
 * `UiButton` is the REAL component. A stub that dropped `variant`, `size` and
 * the icon slots would let a regression in the one control every screen uses
 * pass every suite that clicks it. Its template resolves `Icon` and `NuxtLink`
 * up front, which is why those two are registered alongside it.
 *
 * `UiQueryBoundary` is real for the same reason: list and detail pages show a
 * failed read through it (#721), so a suite mounting one sees the categorized
 * error and its Try again, not an empty custom element.
 *
 * `UiUnsavedChangesDialog` is the leave prompt every guarded settings and
 * editor page renders by its auto-registered name (#1441); it stays closed
 * until a suite opens it.
 *
 * `AppErrorBoundary` (and the `UiErrorBoundary` it renders) wraps every page
 * under the shell, the Postbox panes, message bodies and every composer. Real, so a suite mounting
 * one of those hosts renders its content through the boundary the browser has.
 *
 * `UiShortcut` is the shortcut hint chip the shell, the palette and the
 * onboarding tips render; real, so a suite sees the key a person would.
 *
 * `UiTooltip` wraps most icon-only controls. It is real: it renders the control
 * itself, so a stub would either drop the control or hide the tooltip a
 * suite hovers or focuses to read.
 */
import { config } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiCheckbox from '@owlat/ui/components/ui/Checkbox.vue';
import UiEmptyState from '@owlat/ui/components/ui/EmptyState.vue';
import UiErrorAlert from '@owlat/ui/components/ui/ErrorAlert.vue';
import UiErrorBoundary from '@owlat/ui/components/ui/ErrorBoundary.vue';
import UiSpinner from '@owlat/ui/components/ui/Spinner.vue';
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import UiUnsavedChangesDialog from '@owlat/ui/components/ui/UnsavedChangesDialog.vue';
import UiQueryBoundary from '~/components/ui/QueryBoundary.vue';
import AppErrorBoundary from '~/components/AppErrorBoundary.vue';
import UiShortcut from '~/components/ui/Shortcut.vue';

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
	Object.assign(config.global.components, {
		Icon: IconStub,
		NuxtLink: NuxtLinkStub,
		UiButton,
		UiCheckbox,
		UiQueryBoundary,
		UiEmptyState,
		UiErrorAlert,
		UiErrorBoundary,
		AppErrorBoundary,
		UiSpinner,
		UiUnsavedChangesDialog,
		UiShortcut,
		UiTooltip,
	});
}
