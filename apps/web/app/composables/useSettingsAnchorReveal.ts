import { revealSettingsAnchor } from '~/lib/settingsAnchorReveal';

/**
 * The reveal-and-flash both Settings layouts share: on mount and on every
 * navigation, resolve the hash through `resolveAnchor` (a registry lookup that
 * answers null for any id it does not declare) and reveal what it names.
 *
 * A newer navigation, or leaving the layout, cancels a reveal still waiting
 * for its target, so a slow page can never scroll after you have moved on.
 */
export function useSettingsAnchorReveal(
	resolveAnchor: (path: string, hash: string) => string | null
) {
	const route = useRoute();
	let cancel: (() => void) | null = null;

	function reveal() {
		cancel?.();
		cancel = null;
		const anchor = resolveAnchor(route.path, route.hash);
		if (!anchor) return;
		cancel = revealSettingsAnchor(document, anchor, {
			reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
		});
	}

	onMounted(reveal);
	watch(() => route.fullPath, reveal);
	onBeforeUnmount(() => cancel?.());
}
