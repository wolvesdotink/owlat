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
 *
 * The tray icon's "Pause Notifications" and "Check for Mail" items land here
 * too, so they work on every screen, like Settings, and while the window is
 * hidden to the tray.
 *
 * The deep-link handler is imported when a mailto: arrives, not statically:
 * this file is in every browser's boot bundle, and the handler brings the
 * workspace connect flow with it. The device settings load the same way.
 */
import type { ConvexClient } from 'convex/browser';
import { isDesktopRuntime } from '~/lib/desktop/activeWorkspace';

async function toggleNotifications(): Promise<void> {
	const { loadDesktopAppSettings, useDesktopAppSettings } =
		await import('~/composables/useDesktopAppSettings');
	const current = await loadDesktopAppSettings();
	useDesktopAppSettings().setGlobal('notificationsEnabled', !current.global.notificationsEnabled);
}

export default defineNuxtPlugin({
	name: 'owlat:desktop-menu',
	setup(nuxtApp) {
		if (!isDesktopRuntime()) return;
		const router = useRouter();
		const palette = useCommandPalette();

		void (async () => {
			try {
				const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
				if (getCurrentWebviewWindow().label !== 'main') return;

				const { onMenuAction, onOpenMailto } = await import('@owlat/desktop/src/menu');
				// Device settings live in Preferences; /desktop/settings only redirects here.
				await onMenuAction('preferences', () => void router.push('/dashboard/preferences/device'));
				await onMenuAction('new-workspace', () => void router.push('/desktop/welcome'));
				// Re-dispatched as the window event the auto-updater already listens
				// for (see lib/desktop/updater.client.ts).
				await onMenuAction('check-updates', () =>
					window.dispatchEvent(new Event('owlat:check-updates'))
				);
				// Edit → Find… (⌘F) opens the app's search. Only the dashboard
				// mounts the palette; elsewhere the event has no listener and the
				// shortcut quietly does nothing, same as the titlebar pill.
				await onMenuAction('find', () => palette.open());
				// The tray's "Pause Notifications" flips the master switch the
				// device settings show. Read the stored settings first: before
				// they load, the flip would act on the defaults.
				const { onTrayCheckMail, onTrayToggleNotifications } =
					await import('@owlat/desktop/src/tray');
				await onTrayToggleNotifications(
					() =>
						void toggleNotifications().catch((e: unknown) =>
							console.warn('[desktop] tray toggle failed:', e)
						)
				);
				// The convex client and i18n are read at click time: this plugin runs
				// before the Convex plugin provides its client.
				await onTrayCheckMail(
					() =>
						void import('~/lib/postboxCheckForMail')
							.then(({ checkForMail }) =>
								checkForMail({
									client: nuxtApp.$convex as ConvexClient | null,
									t: (key) => nuxtApp.$i18n.t(key),
									showToast: useToast().showToast,
								})
							)
							.catch((e: unknown) => console.warn('[desktop] tray mail check failed:', e))
				);
				// A mailto: clicked in any Owlat window (the Rust link policy keeps
				// it from the OS) opens our compose window, through the same parser
				// as the OS-level mailto: deep link.
				await onOpenMailto(
					(url) =>
						void import('~/lib/desktop/deepLink.client')
							.then(({ handleDeepLink }) => handleDeepLink(url))
							.catch((e: unknown) => console.warn('[desktop] mailto handling failed:', e))
				);
			} catch {
				// Tauri APIs unavailable — nothing to bridge.
			}
		})();
	},
});
