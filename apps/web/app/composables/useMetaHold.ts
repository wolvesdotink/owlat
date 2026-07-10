/**
 * Track whether the workspace-switch modifier is currently held down.
 *
 * The workspace switcher uses this to reveal the ⌘1–9 (Ctrl+1–9 on
 * Windows/Linux) number hints on its tiles while the modifier is held — making
 * the (already-wired) useWorkspaceHotkeys switch shortcut discoverable.
 * Hold-to-peek, release-to-hide; a window blur resets the state so a ⌘/Ctrl-Tab
 * away (whose keyup never reaches us) can't leave the hints stuck on.
 *
 * The modifier is platform-aware to match useWorkspaceHotkeys' `metaKey ||
 * ctrlKey` gate: ⌘ (Meta) on macOS, Ctrl (Control) on Windows/Linux where the OS
 * swallows the Windows/Super key. Detection mirrors useDesktopContext.isMac.
 *
 * The event handlers are returned alongside the ref so they can be driven
 * directly in unit tests without mounting a component.
 */
import { useDesktopContext } from '~/composables/useDesktopContext';

export function useMetaHold() {
	const { isMac } = useDesktopContext();
	const held = ref(false);

	/** The physical key whose hold reveals the hints, per the current platform. */
	const holdKey = (): 'Meta' | 'Control' => (isMac.value ? 'Meta' : 'Control');

	const onKeydown = (e: KeyboardEvent): void => {
		if (e.key === holdKey()) held.value = true;
	};
	const onKeyup = (e: KeyboardEvent): void => {
		if (e.key === holdKey()) held.value = false;
	};
	const reset = (): void => {
		held.value = false;
	};

	// Guarded so calling the composable outside a component (unit tests) doesn't
	// warn about lifecycle hooks with no active instance.
	if (getCurrentInstance()) {
		onMounted(() => {
			window.addEventListener('keydown', onKeydown);
			window.addEventListener('keyup', onKeyup);
			window.addEventListener('blur', reset);
		});
		onUnmounted(() => {
			window.removeEventListener('keydown', onKeydown);
			window.removeEventListener('keyup', onKeyup);
			window.removeEventListener('blur', reset);
		});
	}

	return { held, onKeydown, onKeyup, reset };
}
