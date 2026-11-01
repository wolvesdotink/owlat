/**
 * The components Nuxt registers for every page, so a mounted tree can reach
 * them: `NuxtLink`, the UI layer's `UiButton` and `UiCheckbox`, and the
 * read-state boundary `UiQueryBoundary` with the three it renders. Icons need
 * nothing here: they are coolicons components each template imports.
 *
 * `UiButton` is the REAL component. A stub that dropped `variant`, `size` and
 * the icon slots would let a regression in the one control every screen uses
 * pass every suite that clicks it. Its template resolves `NuxtLink` up front,
 * which is why it is registered alongside it.
 *
 * `UiQueryBoundary` is real for the same reason: list and detail pages show a
 * failed read through it, so a suite mounting one sees the categorized
 * error and its Try again, not an empty custom element.
 *
 * `UiUnsavedChangesDialog` is the leave prompt every guarded settings and
 * editor page renders by its auto-registered name; it stays closed
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
 *
 * The pickers' primitives (`UiPopover`, `UiListbox`, `UiCombobox`,
 * `UiSuggestionPopover`) are real too: a picker's keys, highlight and ARIA
 * live in them, so a stub would leave a suite typing into nothing. A suite
 * finds popover content under `document.body` (it is teleported there) or
 * stubs `teleport`.
 *
 * `UiDropdownMenu` and `UiDropdownMenuItem` are real too: the composer
 * footer's Send renders them for a reply, and every suite mounting the footer
 * would otherwise need its own stub. A suite that stubs them still wins.
 *
 * `UiPageHeader` renders the page's `h1` and lead on most dashboard pages, so it
 * is real: a suite reading the title, the lead or a header action finds them
 * where the browser does.
 */
import { config } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import UiButton from '@owlat/ui/components/ui/Button.vue';
import UiCheckbox from '@owlat/ui/components/ui/Checkbox.vue';
import UiCombobox from '@owlat/ui/components/ui/Combobox.vue';
import UiDropdownMenu from '@owlat/ui/components/ui/DropdownMenu.vue';
import UiDropdownMenuItem from '@owlat/ui/components/ui/DropdownMenuItem.vue';
import UiEmptyState from '@owlat/ui/components/ui/EmptyState.vue';
import UiErrorAlert from '@owlat/ui/components/ui/ErrorAlert.vue';
import UiErrorBoundary from '@owlat/ui/components/ui/ErrorBoundary.vue';
import UiListbox from '@owlat/ui/components/ui/Listbox.vue';
import UiPageHeader from '@owlat/ui/components/ui/PageHeader.vue';
import UiPopover from '@owlat/ui/components/ui/Popover.vue';
import UiSpinner from '@owlat/ui/components/ui/Spinner.vue';
import UiSuggestionPopover from '@owlat/ui/components/ui/SuggestionPopover.vue';
import UiTooltip from '@owlat/ui/components/ui/Tooltip.vue';
import UiUnsavedChangesDialog from '@owlat/ui/components/ui/UnsavedChangesDialog.vue';
import UiQueryBoundary from '~/components/ui/QueryBoundary.vue';
import AppErrorBoundary from '~/components/AppErrorBoundary.vue';
import UiShortcut from '~/components/ui/Shortcut.vue';

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
		NuxtLink: NuxtLinkStub,
		UiButton,
		UiCheckbox,
		UiDropdownMenu,
		UiDropdownMenuItem,
		UiQueryBoundary,
		UiEmptyState,
		UiErrorAlert,
		UiErrorBoundary,
		AppErrorBoundary,
		UiPageHeader,
		UiSpinner,
		UiUnsavedChangesDialog,
		UiShortcut,
		UiTooltip,
		UiPopover,
		UiListbox,
		UiCombobox,
		UiSuggestionPopover,
	});
}
