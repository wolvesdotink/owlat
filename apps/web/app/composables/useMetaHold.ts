/**
 * Track whether the Meta (⌘) key is currently held down.
 *
 * The workspace switcher uses this to reveal the ⌘1–9 number hints on its tiles
 * while ⌘ is held — making the (already-wired) useWorkspaceHotkeys switch
 * shortcut discoverable. Hold-to-peek, release-to-hide; a window blur resets the
 * state so a ⌘-Tab away (whose keyup never reaches us) can't leave the hints
 * stuck on.
 *
 * The event handlers are returned alongside the ref so they can be driven
 * directly in unit tests without mounting a component.
 */
export function useMetaHold() {
	const held = ref(false);

	const onKeydown = (e: KeyboardEvent): void => {
		if (e.key === 'Meta') held.value = true;
	};
	const onKeyup = (e: KeyboardEvent): void => {
		if (e.key === 'Meta') held.value = false;
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
