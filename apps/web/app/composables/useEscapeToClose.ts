import type { Ref } from 'vue';

/**
 * Esc closes an open popover, and that press ends there.
 *
 * A popover that closes on Esc without claiming the key lets the same press
 * reach the page's own Esc: the Postbox reader closes the conversation
 * (`postbox.close`) and Answer mode leaves for the list, so the person who only
 * meant to dismiss a panel lands somewhere else. The listener is on the
 * document in the capture phase, so it runs before the shortcut dispatcher and
 * the pages' window handlers, and it works while focus is still on the trigger
 * rather than inside the panel. `preventDefault` is the signal every one of
 * those handlers checks first.
 *
 * Registered only while `open` is true.
 */
export function useEscapeToClose(open: Ref<boolean>): void {
	const onKeydown = (event: KeyboardEvent) => {
		if (event.key !== 'Escape' || event.isComposing) return;
		event.preventDefault();
		open.value = false;
	};
	watch(open, (isOpen) => {
		if (isOpen) document.addEventListener('keydown', onKeydown, true);
		else document.removeEventListener('keydown', onKeydown, true);
	});
	onUnmounted(() => document.removeEventListener('keydown', onKeydown, true));
}
