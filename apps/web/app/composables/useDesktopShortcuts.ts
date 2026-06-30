/**
 * Bridges global OS shortcuts into the SPA.
 *
 * Show/hide and quick-compose (which opens the dedicated compose window) are
 * handled entirely in Rust. Here we only receive `quick-switcher` and
 * re-dispatch it as a window CustomEvent (`owlat:quick-switcher`) so a
 * command-palette can react regardless of the current route. Call once from the
 * dashboard layout. No-op on web.
 *
 * Consumers of `owlat:quick-switcher`: the header `GlobalSearch` opens it
 * whenever no `PostboxCommandPalette` is mounted, and `PostboxCommandPalette`
 * owns it whenever one is (it bumps a shared mount counter `GlobalSearch`
 * watches) — so the OS-global shortcut always opens exactly one switcher.
 */
export function useDesktopShortcuts() {
	const { isDesktop } = useDesktopContext();
	const unsubs: Array<() => void> = [];

	onMounted(async () => {
		if (!isDesktop.value) return;
		try {
			const { onShortcut } = await import('@owlat/desktop/src/shortcuts');
			unsubs.push(
				await onShortcut('quick-switcher', () =>
					window.dispatchEvent(new CustomEvent('owlat:quick-switcher')),
				),
			);
		} catch {
			// Tauri not available
		}
	});

	onUnmounted(() => {
		for (const u of unsubs) u();
		unsubs.length = 0;
	});
}
