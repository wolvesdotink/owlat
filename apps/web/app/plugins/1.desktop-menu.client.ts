/**
 * Native application-menu bridge — registered app-wide.
 *
 * The Rust menu (src-tauri menu.rs) emits `menu://<action>` events for its
 * app-level items. This plugin routes them, and it MUST live at plugin level
 * (not in a layout): Settings has to work from every screen, including
 * /desktop/welcome before any workspace is connected — the previous
 * layout-scoped listener (useDesktopMenu, dashboard layout only) made the
 * menu item a silent no-op there.
 *
 * `app.emit` broadcasts to every webview window and the compose window runs
 * this same SPA, so only the `main` window reacts — otherwise one menu click
 * would navigate both windows. Runs after the `0.desktop-workspace` boot
 * plugin (filename order); registration is non-blocking. No-op on web.
 */
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';

export default defineNuxtPlugin({
	name: 'owlat:desktop-menu',
	setup() {
		if (!isDesktopRuntime()) return;
		const router = useRouter();

		void (async () => {
			try {
				const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
				if (getCurrentWebviewWindow().label !== 'main') return;

				const { onMenuAction } = await import('@owlat/desktop/src/menu');
				await onMenuAction('preferences', () => void router.push('/desktop/settings'));
				await onMenuAction('new-workspace', () => void router.push('/desktop/welcome'));
				// Re-dispatched as the window event the auto-updater already listens
				// for (see lib/desktop/updater.client.ts).
				await onMenuAction('check-updates', () =>
					window.dispatchEvent(new Event('owlat:check-updates'))
				);
			} catch {
				// Tauri APIs unavailable — nothing to bridge.
			}
		})();
	},
});
