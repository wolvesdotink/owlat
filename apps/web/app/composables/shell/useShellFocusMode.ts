/**
 * Whether the dashboard shell shows its chrome, and how tall that chrome is.
 *
 * Focus mode state for distraction-free editing. Answer mode (a reply being
 * written, `definePageMeta({ answerMode: true })`) takes the whole screen the
 * same way, so both hide the sidebar and the shell header through one flag.
 * Zen mode (useZenMode) is the app-wide version of the same: one task, no chrome.
 */
import type { RouteLocationNormalizedLoaded } from 'vue-router';
import { useZenMode } from '~/composables/useZenMode';

export function useShellFocusMode(route: Pick<RouteLocationNormalizedLoaded, 'meta'>) {
	const { isFocusMode: isEditorFocusMode } = useFocusMode();
	const { isZen } = useZenMode();
	const isAnswerMode = computed(() => route.meta.answerMode === true);
	const isFocusMode = computed(() => isEditorFocusMode.value || isAnswerMode.value || isZen.value);
	// Zen keeps one slim bar for its exit, except where the page is chrome-less on
	// its own terms and brings its own way out.
	const pageOwnsEscape = computed(() => isAnswerMode.value || isEditorFocusMode.value);
	const showZenBar = computed(() => isZen.value && !pageOwnsEscape.value);
	const shellChromeHeight = computed(() => {
		if (!isFocusMode.value) return '4rem';
		return showZenBar.value ? 'calc(2.75rem + env(safe-area-inset-top, 0px))' : '0px';
	});
	// Below lg the shell is taller: bar, breadcrumb strip, hairline and tab bar.
	const shellChromeMobileHeight = computed(() =>
		isFocusMode.value
			? `calc(${shellChromeHeight.value} + env(safe-area-inset-bottom, 0px))`
			: 'calc(10.25rem + 1px + env(safe-area-inset-top, 0px) + env(safe-area-inset-bottom, 0px))'
	);

	return {
		isAnswerMode,
		isFocusMode,
		pageOwnsEscape,
		showZenBar,
		shellChromeHeight,
		shellChromeMobileHeight,
	};
}
