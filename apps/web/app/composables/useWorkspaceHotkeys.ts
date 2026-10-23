import { workspaceSwitchSlot } from '~/utils/fixedShortcutPresses';

/**
 * ⌘1–⌘9 (Ctrl+1–9 on Windows/Linux) → switch to the Nth connected workspace.
 *
 * A dedicated keydown listener is required because useKeyboardShortcuts bails out
 * the moment a modifier is held. Matches on `event.code` (Digit1…Digit9) so it's
 * keyboard-layout independent and sidesteps the shift/number ambiguity
 * (`workspaceSwitchSlot`, which the remap check reads too). No-op on web, while
 * typing in a field and for a press the dispatcher already claimed (a remapped
 * shortcut on the same keys). switchTo() reloads the webview, so there is no
 * in-memory state to preserve.
 */
export function useWorkspaceHotkeys() {
	const { isDesktop } = useDesktopContext();
	const { workspaces, switchTo } = useDesktopWorkspaces();

	function isEditable(): boolean {
		const el = document.activeElement;
		if (!el) return false;
		const tag = el.tagName.toLowerCase();
		return (
			tag === 'input' ||
			tag === 'textarea' ||
			tag === 'select' ||
			el.getAttribute('contenteditable') === 'true'
		);
	}

	function onKeydown(e: KeyboardEvent) {
		if (e.defaultPrevented) return;
		const slot = workspaceSwitchSlot(e);
		if (slot === null || isEditable()) return;
		const ws = workspaces.value[slot - 1];
		if (!ws) return;
		e.preventDefault();
		void switchTo(ws.id);
	}

	onMounted(() => {
		if (!isDesktop.value) return;
		// oxlint-disable-next-line owlat/no-raw-keydown-listener -- workspace.switch, matched by event.code so it works on every layout
		window.addEventListener('keydown', onKeydown);
	});

	onUnmounted(() => {
		window.removeEventListener('keydown', onKeydown);
	});
}
