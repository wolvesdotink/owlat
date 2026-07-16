/**
 * Bridges native application-menu actions into SPA navigation.
 *
 * The Rust menu (menu.rs) emits `menu://preferences` and `menu://new-workspace`;
 * here we route them to the right pages. `menu://check-updates` is re-dispatched
 * as the `owlat:check-updates` window event the auto-updater already listens for
 * (see apps/web updater.client.ts). Inbox/Chat/Reload and external links are
 * handled entirely in Rust. Call once from the dashboard layout. No-op on web.
 */
export function useDesktopMenu() {
	const { isDesktop } = useDesktopContext();
	const router = useRouter();
	const unsubs: Array<() => void> = [];

	onMounted(async () => {
		if (!isDesktop.value) return;
		try {
			const { onMenuAction } = await import('@owlat/desktop/src/menu');
			unsubs.push(
				await onMenuAction('preferences', () => router.push('/dashboard/settings/desktop')),
				await onMenuAction('new-workspace', () => router.push('/desktop/welcome')),
				await onMenuAction('check-updates', () =>
					window.dispatchEvent(new Event('owlat:check-updates'))
				)
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
