/**
 * ⌘1–⌘9 (Ctrl+1–9 on Windows/Linux) → switch to the Nth connected workspace.
 *
 * A dedicated keydown listener is required because useKeyboardShortcuts bails out
 * the moment a modifier is held. Matches on `event.code` (Digit1…Digit9) so it's
 * keyboard-layout independent and sidesteps the shift/number ambiguity. No-op on
 * web and while typing in a field. switchTo() reloads the webview, so there is no
 * in-memory state to preserve — the keydown just needs to fire first.
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
		if (e.altKey || !(e.metaKey || e.ctrlKey)) return;
		if (!/^Digit[1-9]$/.test(e.code)) return;
		if (isEditable()) return;
		const ws = workspaces.value[Number(e.code.slice(5)) - 1];
		if (!ws) return;
		e.preventDefault();
		void switchTo(ws.id);
	}

	onMounted(() => {
		if (!isDesktop.value) return;
		window.addEventListener('keydown', onKeydown);
	});

	onUnmounted(() => {
		window.removeEventListener('keydown', onKeydown);
	});
}
